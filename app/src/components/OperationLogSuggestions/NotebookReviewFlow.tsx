import { useCallback, useEffect, useRef, useState } from 'react'
import { useCommentAuthor } from '../../contexts/GoogleAuthContext'
import { getNotebookDataController } from '../../lib/notebookDataController'
import {
  parseCommentAnchor,
  resolveRenderedTextAnchor,
} from '../../lib/notebookComments'
import {
  revisionLabel,
  type NotebookRevision,
} from '../../lib/operationLog/revisions'
import {
  parseReviewAnchor,
  type NotebookReviewRound,
} from '../../lib/operationLog/reviews'
import type { DiffCommentTarget } from '../../lib/operationLog/diffCommentAnchor'
import {
  assessComparison,
  commentOnComparison,
} from '../../lib/operationLog/comparisonFeedback'
import type { DriveComment } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import {
  ReviewRevisionPicker,
  type ReviewPreview,
} from './ReviewRevisionPicker'
import { DiffCommentControls } from './DiffCommentControls'
import {
  CellDiscussion,
  DiffCommentComposer,
  ReviewConversation,
} from './ReviewDiscussion'
import { ChangedCell } from './OperationLogSuggestionView'

type Props = {
  docUri: string
  store: LocalNotebooks
  readOnly: boolean
  onClose: () => void
}
const button =
  'rounded border border-nb-border px-2 py-1 text-sm disabled:opacity-40'

/** A comparison is immediately commentable. Legacy review records remain the
 * journal representation, created lazily when feedback needs durable endpoints.
 * Browsing the diff never creates a record or a draft review.
 */
export function NotebookReviewFlow({
  docUri,
  store,
  readOnly,
  onClose,
}: Props) {
  const [revisions, setRevisions] = useState<NotebookRevision[]>([])
  const [records, setRecords] = useState<NotebookReviewRound[]>([])
  const [comments, setComments] = useState<DriveComment[]>([])
  const [preview, setPreview] = useState<ReviewPreview>()
  const [diffTarget, setDiffTarget] = useState<DiffCommentTarget>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const author = useCommentAuthor()
  const load = useCallback(async () => {
    const id = ++sequence.current
    await getNotebookDataController()
      .getNotebookData(docUri)
      ?.flushPendingPersist()
    const [versions, threads, rounds] = await Promise.all([
      store.listNotebookRevisions(docUri),
      store.listOperationLogComments(docUri),
      store.listNotebookReviews(docUri),
    ])
    if (id !== sequence.current) return
    // Comment-only writes must not reset the selected diff or its composer.
    setRevisions((old) =>
      JSON.stringify(old) === JSON.stringify(versions) ? old : versions
    )
    setComments(threads)
    setRecords(rounds)
  }, [docUri, store])
  useEffect(() => {
    void load().catch((e) => setError(String(e)))
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.uri === docUri)
        void load().catch((e) => setError(String(e)))
    }
    window.addEventListener('local-notebook-sync-updated', changed)
    return () => {
      sequence.current++
      window.removeEventListener('local-notebook-sync-updated', changed)
    }
  }, [load, docUri])
  const identity = preview
    ? JSON.stringify([preview.start.id, preview.end.id, preview.cellIds])
    : ''
  useEffect(() => {
    setDiffTarget(undefined)
  }, [identity])
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
  // Compare content operation IDs rather than names or dates; comment/label
  // operations may be different while the frozen content is identical.
  const knownChanges = new Set(revisions.flatMap((r) => r.changeIds))
  const contentKey = (ids: string[]) =>
    JSON.stringify(ids.filter((id) => knownChanges.has(id)).sort())
  const record =
    preview &&
    records.find(
      (r) =>
        contentKey(r.baseOperationIds) ===
          contentKey(preview.start.operationIds) &&
        contentKey(r.headOperationIds) ===
          contentKey(preview.end.operationIds) &&
        JSON.stringify(r.cellIds) ===
          JSON.stringify(preview.cellIds?.slice().sort())
    )
  const selection = (chosen: ReviewPreview) => ({
    startRevisionId: chosen.start.id,
    endRevisionId: chosen.end.id,
    cellIds: chosen.cellIds,
  })
  const cellId = (thread: DriveComment) =>
    parseCommentAnchor(thread.anchor)?.cellId
  const cellThreads = comments.filter(
    (c) =>
      !c.deleted &&
      cellId(c) &&
      (!preview?.cellIds || preview.cellIds.includes(cellId(c)!))
  )
  const discussion = comments.filter(
    (c) =>
      !c.deleted &&
      !cellId(c) &&
      record &&
      (parseReviewAnchor(c.anchor)?.reviewId === record.id ||
        record.aliases?.includes(parseReviewAnchor(c.anchor)?.reviewId ?? '') ||
        record.threadIds.includes(c.id!))
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
    const anchor = parseCommentAnchor(thread.anchor)
    const source = preview?.after.cells.find(
      (c) => c.refId === anchor?.cellId
    )?.value
    const outdated =
      source === undefined ||
      (anchor?.type === 'cell-text'
        ? ['outdated', 'ambiguous'].includes(
            resolveRenderedTextAnchor(anchor, source).status
          )
        : Boolean(anchor?.quote && !source.includes(anchor.quote)))
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
  return (
    <div
      id="notebook-review-flow"
      className="flex h-full min-w-0 bg-white text-nb-text"
    >
      <aside
        id="review-round-panel"
        aria-label="Notebook comparison"
        className="flex w-[380px] max-w-[45%] shrink-0 flex-col overflow-y-auto border-r border-nb-border bg-nb-surface-1 p-4"
      >
        <div
          id="comparison-heading"
          className="flex items-center justify-between gap-2"
        >
          <h2 className="font-semibold">Compare changes</h2>
          <button className={button} onClick={onClose}>
            Edit view
          </button>
        </div>
        {revisions.length > 0 && (
          <ReviewRevisionPicker
            revisions={revisions}
            store={store}
            docUri={docUri}
            disabled={busy}
            onPreview={setPreview}
            readOnly={readOnly}
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
        {error && (
          <p role="alert" className="my-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {preview && (
          <>
            <ReviewConversation
              key={identity}
              comments={discussion}
              disabled={busy || readOnly}
              onSend={(content, rootId) =>
                rootId
                  ? reply(rootId, content)
                  : run(async () => {
                      await commentOnComparison(store, docUri, {
                        ...selection(preview),
                        content,
                        author: await author(),
                      })
                    })
              }
            />
            <section
              id="comparison-assessment"
              aria-label="Suggestion assessment"
              className="border-t pt-3"
            >
              <h3 className="font-medium">Is this suggestion good enough?</h3>
              <p className="my-2 text-xs">
                Applies to these revisions and{' '}
                {preview.cellIds
                  ? `${preview.cellIds.length} selected cells`
                  : 'the whole document'}
                . Does not undo edits or resolve comments.
              </p>
              {record?.outcome && (
                <p role="status" className="my-2 text-sm">
                  {record.outcome === 'good_enough' ||
                  record.outcome === 'approve'
                    ? 'Good Enough'
                    : record.outcome === 'comment'
                      ? 'Commented'
                      : 'Needs More Work'}
                </p>
              )}
              <div id="comparison-assessment-actions" className="flex gap-2">
                {(['good_enough', 'needs_more_work'] as const).map(
                  (outcome) => (
                    <button
                      key={outcome}
                      className={button}
                      disabled={busy || readOnly}
                      onClick={() =>
                        void run(async () => {
                          await assessComparison(store, docUri, {
                            ...selection(preview),
                            outcome,
                            author: await author(),
                          })
                        })
                      }
                    >
                      {outcome === 'good_enough'
                        ? 'Good Enough'
                        : 'Needs More Work'}
                    </button>
                  )
                )}
              </div>
            </section>
          </>
        )}
      </aside>
      <main
        id="review-round-canvas"
        className="min-w-0 flex-1 overflow-auto p-6"
      >
        {!preview ? (
          <p>Select start and end revisions to compare changes.</p>
        ) : (
          <>
            <h2 className="mb-4 font-semibold">
              {revisionLabel(preview.start)} → {revisionLabel(preview.end)}
            </h2>
            {preview.diff.cells.map((row, i) => (
              <article
                id={`review-diff-${row.id}`}
                key={identity + row.id}
                tabIndex={-1}
                className="mb-4 focus:outline focus:outline-2 focus:outline-nb-accent"
              >
                <p className="mb-1 text-xs">
                  Cell {i + 1} · {row.kind}
                </p>
                <DiffCommentControls
                  row={row}
                  disabled={readOnly || busy}
                  onComment={setDiffTarget}
                >
                  <ChangedCell row={row} />
                </DiffCommentControls>
                {cellThreads
                  .filter(
                    (c) =>
                      cellId(c) === (row.compareCell ?? row.baseCell)?.refId
                  )
                  .map(renderThread)}
                {diffTarget &&
                  diffTarget.cellId ===
                    (row.compareCell ?? row.baseCell)?.refId && (
                    <DiffCommentComposer
                      key={identity + diffTarget.cellId}
                      target={diffTarget}
                      disabled={busy || readOnly}
                      onCancel={() => setDiffTarget(undefined)}
                      onSend={(content) =>
                        run(async () => {
                          await commentOnComparison(store, docUri, {
                            ...selection(preview),
                            content,
                            cellId: diffTarget.cellId,
                            side: diffTarget.side,
                            sourceRange: diffTarget.sourceRange,
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
            {cellThreads.some(
              (c) =>
                !preview.diff.cells.some(
                  (row) =>
                    (row.compareCell ?? row.baseCell)?.refId === cellId(c)
                )
            ) && (
              <section aria-label="Discussions on earlier cells">
                <h3>Discussions on cells absent from this comparison</h3>
                {cellThreads
                  .filter(
                    (c) =>
                      !preview.diff.cells.some(
                        (row) =>
                          (row.compareCell ?? row.baseCell)?.refId === cellId(c)
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
