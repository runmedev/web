import { useCallback, useEffect, useRef, useState } from 'react'
import {
  revisionLabel,
  type NotebookRevision,
} from '../../lib/operationLog/revisions'
import {
  ReviewRevisionPicker,
  type ReviewPreview,
} from './ReviewRevisionPicker'
import { useCommentAuthor } from '../../contexts/GoogleAuthContext'
import { getNotebookDataController } from '../../lib/notebookDataController'
import {
  createReviewAnchor,
  parseReviewAnchor,
  type NotebookReviewRound,
  type ReviewOutcome,
} from '../../lib/operationLog/reviews'
import type { DriveComment } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import {
  parseDiffCommentTarget,
  type DiffCommentTarget,
} from '../../lib/operationLog/diffCommentAnchor'
import { DiffCommentControls } from './DiffCommentControls'
import {
  CellDiscussion,
  DiffCommentComposer,
  ReviewConversation,
} from './ReviewDiscussion'
import {
  ChangedCell,
  OperationLogSuggestionView,
} from './OperationLogSuggestionView'

type Props = {
  docUri: string
  store: LocalNotebooks
  readOnly: boolean
  onClose: () => void
}
const button =
  'rounded border border-nb-border px-2 py-1 text-sm disabled:opacity-40'
const outcomeLabel = (outcome?: ReviewOutcome) =>
  outcome === 'approve'
    ? 'Approved'
    : outcome === 'request_changes'
      ? 'Changes requested'
      : outcome === 'comment'
        ? 'Commented'
        : 'Draft'

/** Fixed review rounds share the journal with the editor; only selection is local UI state. */
export function NotebookReviewFlow(props: Props) {
  const { docUri, store, readOnly, onClose } = props
  const [individual, setIndividual] = useState(false)
  const [rounds, setRounds] = useState<NotebookReviewRound[]>([])
  const [selected, setSelected] = useState('')
  const [revisions, setRevisions] = useState<NotebookRevision[]>([])
  const [preview, setPreview] = useState<ReviewPreview>()
  const [comments, setComments] = useState<DriveComment[]>([])
  const [diffTarget, setDiffTarget] = useState<DiffCommentTarget>()
  const [outcome, setOutcome] = useState<ReviewOutcome>('comment')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const loadSequence = useRef(0)
  const author = useCommentAuthor()
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    const [next, threads, versions] = await Promise.all([
      store.listNotebookReviews(docUri),
      store.listOperationLogComments(docUri),
      store.listNotebookRevisions(docUri),
    ])
    if (sequence !== loadSequence.current) return
    setRounds(next)
    setComments(threads)
    setRevisions(versions)
    setSelected((current) =>
      current === 'new' || next.some((round) => round.id === current)
        ? current
        : (next.at(-1)?.id ?? 'new')
    )
  }, [store, docUri])
  useEffect(() => {
    void load().catch((e) => setError(String(e)))
    const updated = (event: Event) => {
      if ((event as CustomEvent).detail?.uri === docUri)
        void load().catch((e) => setError(String(e)))
    }
    window.addEventListener('local-notebook-sync-updated', updated)
    return () => {
      loadSequence.current++
      window.removeEventListener('local-notebook-sync-updated', updated)
    }
  }, [load, docUri])
  const round = rounds.find((r) => r.id === selected)
  const run = async (action: () => Promise<void>) => {
    if (readOnly || busy) return false
    setBusy(true)
    setError('')
    try {
      await action()
      await load()
      return true
    } catch (e) {
      setError(String(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const create = (chosen: ReviewPreview) =>
    run(async () => {
      if (chosen.existingReviewId) {
        setSelected(chosen.existingReviewId)
        return
      }
      const next = await store.createNotebookReview(docUri, {
        title: `Round ${rounds.length + 1}`,
        startRevisionId: chosen.start.id,
        endRevisionId: chosen.end.id,
        author: await author(),
      })
      const base = rounds.find(
        (r) => versionFor(r.headOperationIds)?.id === chosen.start.id
      )
      if (base)
        for (const thread of comments) {
          if (
            thread.id &&
            !thread.resolved &&
            (parseReviewAnchor(thread.anchor)?.reviewId === base.id ||
              base.threadIds.includes(thread.id))
          )
            await store.linkNotebookReviewThread(docUri, next.id, thread.id)
        }
      setSelected(next.id)
      setDiffTarget(undefined)
      setPreview(undefined)
      setSummary('')
    })
  const versionFor = (ids: string[]) => {
    const knownChanges = new Set(revisions.flatMap((r) => r.changeIds))
    const changes = ids.filter((id) => knownChanges.has(id))
    return revisions.find(
      (r) =>
        r.changeIds.length === changes.length &&
        r.changeIds.every((id) => changes.includes(id))
    )
  }
  const comparison = round ?? (selected === 'new' ? preview : undefined)
  if (individual)
    return (
      <div id="individual-suggestion-mode" className="flex h-full flex-col">
        <button className={button} onClick={() => setIndividual(false)}>
          Back to review rounds
        </button>
        <div className="min-h-0 flex-1">
          <OperationLogSuggestionView {...props} />
        </div>
      </div>
    )
  const threads = round
    ? comments.filter(
        (c) =>
          parseReviewAnchor(c.anchor)?.reviewId === round.id ||
          round.aliases?.includes(
            parseReviewAnchor(c.anchor)?.reviewId ?? ''
          ) ||
          (c.id && round.threadIds.includes(c.id))
      )
    : []
  const cellThreads = threads.filter((c) => parseReviewAnchor(c.anchor)?.cellId)
  const reviewThreads = threads.filter(
    (c) => !parseReviewAnchor(c.anchor)?.cellId
  )
  const reply = (id: string, content: string) =>
    run(async () => {
      await store.replyToOperationLogComment(docUri, id, content, {
        author: await author(),
      })
    })
  const resolve = (id: string, resolved: boolean) =>
    run(async () => {
      await store.setOperationLogCommentResolved(docUri, id, resolved)
    })
  const renderThread = (thread: DriveComment) => {
    const anchor = parseReviewAnchor(thread.anchor)
    const target = parseDiffCommentTarget(thread.anchor)
    const origin = rounds.find(
      (r) =>
        r.id === anchor?.reviewId || r.aliases?.includes(anchor?.reviewId ?? '')
    )
    const original = (
      target?.side === 'base' ? origin?.before : origin?.after
    )?.cells.find((c) => c.refId === anchor?.cellId)
    const current = round?.after.cells.find((c) => c.refId === anchor?.cellId)
    const outdated =
      origin?.id !== round?.id &&
      current?.value !== (original?.value ?? anchor?.quote)
    return (
      <CellDiscussion
        key={thread.id}
        thread={thread}
        disabled={busy || readOnly}
        outdated={outdated}
        onReply={reply}
        onResolve={resolve}
      />
    )
  }
  const changed =
    comparison?.diff.cells.filter((row) => row.kind !== 'unchanged') ?? []
  return (
    <div
      id="notebook-review-flow"
      className="flex h-full min-w-0 bg-white text-nb-text"
    >
      <aside
        id="review-round-panel"
        aria-label="Notebook review"
        className="flex w-[380px] max-w-[45%] shrink-0 flex-col overflow-y-auto border-r border-nb-border bg-nb-surface-1 p-4"
      >
        <div
          id="review-round-heading"
          className="flex items-center justify-between gap-2"
        >
          <h2 className="font-semibold">Review rounds</h2>
          <button className={button} onClick={onClose}>
            Edit view
          </button>
        </div>
        <p className="my-2 text-xs text-nb-text-muted">
          Fixed comparisons. Discussions continue across revisions.
        </p>
        <label className="my-2 text-sm">
          Review
          <select
            aria-label="Review round"
            className="mt-1 w-full rounded border p-2"
            value={selected}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value)
              setDiffTarget(undefined)
              setPreview(undefined)
              if (e.target.value === 'new')
                void getNotebookDataController()
                  .getNotebookData(docUri)
                  ?.flushPendingPersist()
                  .then(load)
                  .catch((error) => setError(String(error)))
            }}
          >
            <option value="new">{'<start new review>'}</option>
            {rounds.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} · {outcomeLabel(r.outcome)}
              </option>
            ))}
          </select>
        </label>
        {selected === 'new' && (
          <ReviewRevisionPicker
            revisions={revisions}
            store={store}
            docUri={docUri}
            disabled={busy || readOnly}
            onPreview={setPreview}
            onStart={(chosen) => void create(chosen)}
            onLabel={(revisionId, name, description) =>
              run(async () => {
                await store.labelNotebookRevision(docUri, {
                  revisionId,
                  name,
                  description,
                  author: await author(),
                })
              })
            }
          />
        )}
        <button
          className={`${button} mt-2`}
          onClick={() => setIndividual(true)}
        >
          Individual suggestions · accept/reject
        </button>
        {error && (
          <p role="alert" className="my-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {round && (
          <>
            <p className="mt-4 text-sm font-medium">
              {round.title} · {outcomeLabel(round.outcome)}
            </p>
            <p className="text-xs text-nb-text-muted">Fixed comparison</p>
            <p className="text-xs">
              Start:{' '}
              {versionFor(round.baseOperationIds)
                ? revisionLabel(versionFor(round.baseOperationIds)!)
                : 'Historical revision'}
            </p>
            <p className="text-xs">
              End:{' '}
              {versionFor(round.headOperationIds)
                ? revisionLabel(versionFor(round.headOperationIds)!)
                : 'Historical revision'}
            </p>
            <p className="my-2 text-xs">
              Comments are shared immediately, including in drafts.
            </p>
            <nav
              aria-label="Review changes"
              className="my-2 flex flex-wrap gap-1"
            >
              {changed.map((row, i) => (
                <button
                  key={row.id}
                  className={button}
                  onClick={() =>
                    document
                      .getElementById(`review-diff-${row.id}`)
                      ?.scrollIntoView({ block: 'center' })
                  }
                >
                  Change {i + 1}
                </button>
              ))}
            </nav>
            <ReviewConversation
              key={docUri + round.id}
              comments={reviewThreads}
              disabled={busy || readOnly}
              onSend={(content, rootId) =>
                rootId
                  ? reply(rootId, content)
                  : run(async () => {
                      await store.addOperationLogComment(docUri, {
                        content,
                        anchor: createReviewAnchor(round.id),
                        author: await author(),
                      })
                    })
              }
            />
            <div id="review-submit" className="mt-4 border-t pt-3">
              <h3 className="font-medium">Submit review</h3>
              {round.submittedAt && (
                <p className="my-2 text-xs text-nb-text-muted">
                  {outcomeLabel(round.outcome)} by{' '}
                  {round.submittedBy?.displayName ?? 'unknown'} ·{' '}
                  <time dateTime={round.submittedAt}>
                    {new Date(round.submittedAt).toLocaleString()}
                  </time>
                </p>
              )}
              {round.summary && <p className="my-2 text-sm">{round.summary}</p>}
              <select
                aria-label="Review outcome"
                className="my-2 w-full rounded border p-2 text-sm"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as ReviewOutcome)}
              >
                <option value="comment">Comment</option>
                <option value="request_changes">Request changes</option>
                <option value="approve">Approve</option>
              </select>
              <textarea
                aria-label="Review summary"
                className="w-full rounded border p-2 text-sm"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
              <button
                className={`${button} mt-1`}
                disabled={busy || readOnly || Boolean(round.outcome)}
                onClick={() =>
                  void run(async () => {
                    await store.submitNotebookReview(docUri, {
                      reviewId: round.id,
                      outcome,
                      summary,
                      author: await author(),
                    })
                  })
                }
              >
                Submit review
              </button>
              <p className="mt-2 text-xs text-nb-text-muted">
                Submission does not change notebook contents or resolve threads.
              </p>
            </div>
          </>
        )}
      </aside>
      <main
        id="review-round-canvas"
        className="min-w-0 flex-1 overflow-auto p-6"
      >
        {!comparison ? (
          <p>Select start and end revisions to preview a comparison.</p>
        ) : (
          <>
            <h2 className="mb-4 font-semibold">
              {round
                ? round.title + ' · fixed revision comparison'
                : 'Preview · ' +
                  revisionLabel(preview!.start) +
                  ' → ' +
                  revisionLabel(preview!.end)}
            </h2>
            {comparison.diff.cells.map((row, i) => (
              <article
                id={`review-diff-${row.id}`}
                key={row.id}
                tabIndex={-1}
                className="mb-4 focus:outline focus:outline-2 focus:outline-nb-accent"
              >
                <p className="mb-1 text-xs">
                  Cell {i + 1} · {row.kind}
                </p>
                <DiffCommentControls
                  key={`${round?.id ?? preview?.start.id + ':' + preview?.end.id}-${row.id}`}
                  row={row}
                  disabled={readOnly || busy || !round}
                  onComment={(target) => {
                    setDiffTarget(target)
                  }}
                >
                  <ChangedCell row={row} />
                </DiffCommentControls>
                {cellThreads
                  .filter(
                    (c) =>
                      parseReviewAnchor(c.anchor)?.cellId ===
                      (row.compareCell ?? row.baseCell)?.refId
                  )
                  .map(renderThread)}
                {round &&
                  diffTarget?.cellId ===
                    (row.compareCell ?? row.baseCell)?.refId && (
                    <DiffCommentComposer
                      key={round.id + diffTarget!.cellId}
                      target={diffTarget!}
                      disabled={busy || readOnly}
                      onCancel={() => setDiffTarget(undefined)}
                      onSend={(content) =>
                        run(async () => {
                          await store.addOperationLogComment(docUri, {
                            content,
                            anchor: createReviewAnchor(
                              round.id,
                              diffTarget!.cellId,
                              diffTarget!.quote,
                              diffTarget
                            ),
                            author: await author(),
                          })
                        })
                      }
                    />
                  )}
                {JSON.stringify(row.baseCell?.outputs ?? []) !==
                  JSON.stringify(row.compareCell?.outputs ?? []) && (
                  <details>
                    <summary className="text-xs">Outputs changed</summary>
                    <pre className="whitespace-pre-wrap text-xs">
                      {JSON.stringify(
                        {
                          before: row.baseCell?.outputs,
                          after: row.compareCell?.outputs,
                        },
                        null,
                        2
                      )}
                    </pre>
                  </details>
                )}
              </article>
            ))}
            {cellThreads.filter(
              (c) =>
                !comparison.diff.cells.some(
                  (row) =>
                    (row.compareCell ?? row.baseCell)?.refId ===
                    parseReviewAnchor(c.anchor)?.cellId
                )
            ).length > 0 && (
              <section aria-label="Discussions on earlier cells">
                <h3>Discussions on cells absent from this comparison</h3>
                {cellThreads
                  .filter(
                    (c) =>
                      !comparison.diff.cells.some(
                        (row) =>
                          (row.compareCell ?? row.baseCell)?.refId ===
                          parseReviewAnchor(c.anchor)?.cellId
                      )
                  )
                  .map(renderThread)}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
