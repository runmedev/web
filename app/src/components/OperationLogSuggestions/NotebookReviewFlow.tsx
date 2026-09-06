import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckIcon,
  XMarkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/20/solid'
import {
  acceptedCell,
  cellDecisionFor,
} from '../../lib/operationLog/cellReview'
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
  decideComparisonCell,
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
  CellChangeInput,
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
  // Hide, rather than unmount, the controls so comparison selection and drafts
  // survive collapsing the panel and switching between notebook tabs.
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [commentsCollapsed, setCommentsCollapsed] = useState(false)
  const pendingGutterFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (commentsCollapsed || !pendingGutterFocus.current) return
    const gutter = pendingGutterFocus.current
    pendingGutterFocus.current = null
    gutter.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    gutter.focus({ preventScroll: true })
  }, [commentsCollapsed])
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
        className={`flex shrink-0 flex-col overflow-y-auto border-r border-nb-border bg-nb-surface-1 ${panelCollapsed ? 'w-12 p-2' : 'w-[380px] max-w-[45%] p-4'}`}
      >
        <div
          id="comparison-heading"
          className="flex items-center justify-between gap-2"
        >
          <h2 hidden={panelCollapsed} className="font-semibold">
            Compare changes
          </h2>
          <button hidden={panelCollapsed} className={button} onClick={onClose}>
            Edit view
          </button>
          <button
            type="button"
            aria-label={
              panelCollapsed
                ? 'Expand comparison panel'
                : 'Collapse comparison panel'
            }
            title={
              panelCollapsed
                ? 'Expand comparison panel'
                : 'Collapse comparison panel'
            }
            aria-expanded={!panelCollapsed}
            aria-controls="comparison-controls"
            className="shrink-0 rounded p-1 hover:bg-nb-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent"
            onClick={() => setPanelCollapsed((collapsed) => !collapsed)}
          >
            {panelCollapsed ? (
              <ChevronRightIcon className="h-5 w-5" aria-hidden="true" />
            ) : (
              <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </div>
        <div id="comparison-controls" hidden={panelCollapsed}>
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
        </div>
      </aside>
      <main
        id="review-round-canvas"
        className="min-w-0 flex-1 overflow-auto p-6"
      >
        {panelCollapsed && error && (
          <p role="alert" className="mb-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {!preview ? (
          <p>Select start and end revisions to compare changes.</p>
        ) : (
          <>
            <div
              id="comparison-canvas-heading"
              className="mb-4 flex items-start justify-between gap-3"
            >
              <h2 className="min-w-0 font-semibold">
                {revisionLabel(preview.start)} → {revisionLabel(preview.end)}
              </h2>
              <button
                type="button"
                className={`${button} shrink-0`}
                aria-expanded={!commentsCollapsed}
                aria-controls={
                  preview.diff.cells
                    .map((row) => `review-comments-${row.id}`)
                    .join(' ') || undefined
                }
                onClick={() => setCommentsCollapsed((collapsed) => !collapsed)}
              >
                {commentsCollapsed ? 'Show comments' : 'Hide comments'}
              </button>
            </div>
            {preview.diff.cells.map((row, i) => {
              const rowCellId = (row.compareCell ?? row.baseCell)?.refId
              const decision = cellDecisionFor(row, records)
              const shownRow = decision
                ? acceptedCell(
                    decision.decision === 'undo'
                      ? { ...row, compareCell: row.baseCell }
                      : row
                  )
                : row
              const threads = cellThreads.filter((c) => cellId(c) === rowCellId)
              const gutterId = `review-comments-${row.id}`
              // A shared two-column layout keeps threads beside their cell,
              // without measuring text or overlapping neighboring discussions.
              // Preserve the gutter on empty rows so the diff width stays stable.
              return (
                <article
                  id={`review-diff-${row.id}`}
                  key={identity + row.id}
                  tabIndex={-1}
                  aria-label={`Cell ${i + 1} · ${row.kind}`}
                  className={`mb-4 grid items-start gap-4 focus:outline focus:outline-2 focus:outline-nb-accent ${commentsCollapsed ? 'min-w-0 grid-cols-1' : 'min-w-[480px] grid-cols-[minmax(0,1fr)_clamp(220px,40%,320px)]'}`}
                >
                  <div
                    id={`review-cell-content-${row.id}`}
                    className="relative min-w-0 pr-4"
                  >
                    {shownRow && (
                      <DiffCommentControls
                        row={row}
                        defaultSide={
                          decision?.decision === 'undo' ? 'base' : undefined
                        }
                        disabled={readOnly || busy}
                        onComment={(target) => {
                          setCommentsCollapsed(false)
                          setDiffTarget(target)
                        }}
                      >
                        <ChangedCell
                          row={shownRow}
                          plainSide={
                            decision?.decision === 'undo'
                              ? 'base'
                              : decision
                                ? 'head'
                                : 'both'
                          }
                        />
                      </DiffCommentControls>
                    )}
                    {threads.length > 0 && (
                      <button
                        type="button"
                        aria-label={`Show ${threads.length} comment threads for cell ${i + 1}`}
                        aria-controls={gutterId}
                        title={`${threads.length} comment threads — view in right gutter`}
                        className="absolute inset-y-0 right-0 w-3 rounded-r border-r-4 border-nb-accent hover:bg-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent"
                        onClick={() => {
                          const gutter = document.getElementById(gutterId)
                          if (commentsCollapsed) {
                            pendingGutterFocus.current = gutter
                            setCommentsCollapsed(false)
                            return
                          }
                          gutter?.scrollIntoView({
                            block: 'nearest',
                            inline: 'nearest',
                          })
                          gutter?.focus({ preventScroll: true })
                        }}
                      />
                    )}
                    {!decision &&
                      JSON.stringify(row.baseCell?.outputs ?? []) !==
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
                  </div>
                  <aside
                    id={gutterId}
                    hidden={commentsCollapsed}
                    aria-label={`Comments for cell ${i + 1}`}
                    tabIndex={-1}
                    className="min-w-0 space-y-2 break-words rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent"
                  >
                    {row.kind !== 'unchanged' && (
                      <section
                        aria-label={`Changes for cell ${i + 1}`}
                        className="rounded border border-nb-border bg-white p-3"
                      >
                        <div
                          id={`cell-decision-${row.id}`}
                          className="flex items-center justify-between gap-2"
                        >
                          <p role="status" className="text-sm font-medium">
                            {decision?.decision === 'accept'
                              ? 'Changes accepted'
                              : decision?.decision === 'undo'
                                ? 'Changes undone'
                                : 'Suggested changes'}
                          </p>
                          <div
                            id={`cell-decision-actions-${row.id}`}
                            className="flex gap-1"
                          >
                            {(['accept', 'undo'] as const).map((action) => (
                              <button
                                key={action}
                                type="button"
                                title={
                                  action === 'accept'
                                    ? 'Accept changes to this cell'
                                    : 'Undo changes to this cell'
                                }
                                aria-label={`${action === 'accept' ? 'Accept' : 'Undo'} changes to cell ${i + 1}`}
                                disabled={
                                  busy ||
                                  readOnly ||
                                  decision?.decision === action ||
                                  decision?.decision === 'undo'
                                }
                                className="rounded p-1 text-nb-accent hover:bg-blue-50 disabled:opacity-40"
                                onClick={() =>
                                  void run(async () => {
                                    await decideComparisonCell(
                                      store,
                                      docUri,
                                      {
                                        ...selection(preview),
                                        cellId: rowCellId!,
                                        decision: action,
                                        author: await author(),
                                      },
                                      getNotebookDataController().getNotebookData(
                                        docUri
                                      ) ?? undefined
                                    )
                                  })
                                }
                              >
                                {action === 'accept' ? (
                                  <CheckIcon
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <XMarkIcon
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                        <CellChangeInput
                          label={`Comment on changes to cell ${i + 1}`}
                          disabled={busy || readOnly}
                          onSend={(content) =>
                            run(async () => {
                              await commentOnComparison(store, docUri, {
                                ...selection(preview),
                                content,
                                cellId: rowCellId!,
                                author: await author(),
                              })
                            })
                          }
                        />
                      </section>
                    )}
                    {threads.map(renderThread)}
                    {diffTarget && diffTarget.cellId === rowCellId && (
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
                  </aside>
                </article>
              )
            })}
            {cellThreads.some(
              (c) =>
                !preview.diff.cells.some(
                  (row) =>
                    (row.compareCell ?? row.baseCell)?.refId === cellId(c)
                )
            ) && (
              <section
                hidden={commentsCollapsed}
                aria-label="Discussions on earlier cells"
              >
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
