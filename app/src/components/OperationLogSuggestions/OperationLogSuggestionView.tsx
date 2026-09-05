import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid'
import { Badge, Button, Text } from '@radix-ui/themes'

import { parser_pb } from '../../runme/client'
import { isLinkedResourceCell } from '../../lib/linkedResource'
import { getNotebookDataController } from '../../lib/notebookDataController'
import {
  buildOperationLogSuggestions,
  createSuggestionCommentAnchor,
  diffInlineText,
  materializeOperationLog,
  materializedLogToNotebook,
  parseOperationLog,
  parseSuggestionCommentAnchor,
  type OperationLogSuggestion,
  type SuggestionDecision,
} from '../../lib/operationLog'
import type { CellDiff } from '../../lib/notebookDiff/model'
import type { DriveComment } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import { showToast } from '../../lib/toast'

function cellLabel(row: CellDiff): string {
  const cell = row.compareCell ?? row.baseCell
  if (!cell) return 'Cell'
  if (isLinkedResourceCell(cell)) return 'Linked resource'
  return (
    cell.languageId ||
    (cell.kind === parser_pb.CellKind.MARKUP ? 'Markdown' : 'Code')
  )
}

function summary(suggestion: OperationLogSuggestion): string {
  const { summary: counts } = suggestion.diff
  const parts = [
    counts.insertedCells ? `${counts.insertedCells} inserted` : '',
    counts.deletedCells ? `${counts.deletedCells} deleted` : '',
    counts.modifiedCells ? `${counts.modifiedCells} modified` : '',
    counts.movedCells ? `${counts.movedCells} moved` : '',
  ].filter(Boolean)
  return parts.join(', ') || 'Notebook metadata changed'
}

/** Format operation-log comment timestamps using the same local-time treatment
 * as the Google Drive comments panel. */
function formatCommentTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function PlainCell({ value }: { value: string }) {
  return (
    <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
      {value || <span className="text-nb-text-faint">Empty cell</span>}
    </pre>
  )
}

function ChangedCell({ row }: { row: CellDiff }) {
  const before = row.baseCell?.value ?? ''
  const after = row.compareCell?.value ?? ''
  const nonText = Boolean(
    (row.baseCell && isLinkedResourceCell(row.baseCell)) ||
      (row.compareCell && isLinkedResourceCell(row.compareCell))
  )

  if (row.kind === 'unchanged') {
    return (
      <div
        id={`suggestion-cell-unchanged-${row.id}`}
        className="rounded-nb-sm border border-nb-border bg-white text-nb-text"
      >
        <PlainCell value={after || before} />
      </div>
    )
  }

  if (row.kind === 'inserted') {
    return (
      <div
        id={`suggestion-cell-inserted-${row.id}`}
        className="rounded-nb-sm border-2 border-emerald-400 bg-emerald-50 text-emerald-950"
        data-testid="suggestion-inserted-cell"
      >
        <PlainCell value={after} />
      </div>
    )
  }
  if (row.kind === 'deleted') {
    return (
      <div
        id={`suggestion-cell-deleted-${row.id}`}
        className="rounded-nb-sm border-2 border-red-400 bg-red-50 text-red-900 line-through decoration-red-600"
        data-testid="suggestion-deleted-cell"
      >
        <PlainCell value={before} />
      </div>
    )
  }
  if (nonText) {
    return (
      <div
        id={`suggestion-cell-replaced-${row.id}`}
        className="space-y-2"
        data-testid="suggestion-replaced-cell"
      >
        <div
          id={`suggestion-cell-replaced-before-${row.id}`}
          className="rounded-nb-sm border-2 border-red-400 bg-red-50 text-red-900 line-through"
        >
          <PlainCell value={before} />
        </div>
        <div
          id={`suggestion-cell-replaced-after-${row.id}`}
          className="rounded-nb-sm border-2 border-emerald-400 bg-emerald-50 text-emerald-950"
        >
          <PlainCell value={after} />
        </div>
      </div>
    )
  }
  const segments = diffInlineText(before, after)
  return (
    <div
      id={`suggestion-cell-modified-${row.id}`}
      className="rounded-nb-sm border-2 border-amber-300 bg-white"
      data-testid="suggestion-modified-cell"
    >
      <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
        {segments.map((segment, index) => (
          <span
            key={`${segment.kind}-${index}`}
            className={
              segment.kind === 'inserted'
                ? 'bg-emerald-100 text-emerald-800'
                : segment.kind === 'deleted'
                  ? 'bg-red-100 text-red-700 line-through decoration-red-600'
                  : 'text-nb-text'
            }
          >
            {segment.value}
          </span>
        ))}
      </pre>
    </div>
  )
}

function SuggestionComments({
  comments,
  disabled,
  onComment,
  onReply,
}: {
  comments: DriveComment[]
  disabled: boolean
  onComment: (content: string) => Promise<void>
  onReply: (commentId: string, content: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})

  const submitComment = () => {
    const value = draft.trim()
    if (!value) return
    void onComment(value)
      .then(() => setDraft(''))
      .catch(() => undefined)
  }

  const submitReply = (commentId: string) => {
    const value = (replyDrafts[commentId] ?? '').trim()
    if (!value) return
    void onReply(commentId, value)
      .then(() =>
        setReplyDrafts((current) => ({
          ...current,
          [commentId]: '',
        }))
      )
      .catch(() => undefined)
  }

  return (
    <section
      id="suggestion-comments"
      className="flex min-h-0 flex-1 flex-col border-t border-nb-border"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <Text as="p" size="2" weight="bold">
          Discussion
        </Text>
        <span className="rounded-full bg-nb-surface-2 px-2 py-0.5 text-[11px] text-nb-text-muted">
          {comments.length}
        </span>
      </div>
      <div
        id="suggestion-comment-list"
        className="min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-3"
      >
        {comments.map((comment) => {
          const commentId = comment.id
          if (!commentId) return null
          return (
            <article
              key={commentId}
              className="rounded-nb-sm border border-nb-border bg-white p-3 text-sm shadow-sm"
              data-suggestion-comment-thread
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <span className="text-xs font-medium text-nb-text">
                  {comment.author?.displayName ?? 'Commenter'}
                </span>
                <span className="text-[11px] text-nb-text-faint">
                  {formatCommentTime(
                    comment.modifiedTime ?? comment.createdTime
                  )}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-nb-text">
                {comment.content}
              </p>
              {(comment.replies ?? []).filter((reply) => !reply.deleted)
                .length > 0 && (
                <div className="mt-3 space-y-2 border-l border-nb-border pl-3">
                  {(comment.replies ?? [])
                    .filter((reply) => !reply.deleted)
                    .map((reply) => (
                      <div
                        id={`suggestion-comment-reply-${reply.id}`}
                        key={
                          reply.id ?? `${reply.createdTime}-${reply.content}`
                        }
                      >
                        <div className="flex items-start justify-between gap-2 text-[11px]">
                          <span className="font-medium text-nb-text-muted">
                            {reply.author?.displayName ?? 'Reply'}
                          </span>
                          <span className="text-nb-text-faint">
                            {formatCommentTime(
                              reply.modifiedTime ?? reply.createdTime
                            )}
                          </span>
                        </div>
                        {reply.content && (
                          <p className="whitespace-pre-wrap text-xs text-nb-text">
                            {reply.content}
                          </p>
                        )}
                      </div>
                    ))}
                </div>
              )}
              <textarea
                id={`suggestion-comment-reply-form-${commentId}`}
                aria-label={`Reply to comment ${commentId}`}
                className="mt-3 h-16 w-full resize-none rounded-nb-sm border border-nb-border bg-white p-2 text-xs text-nb-text outline-none focus:border-nb-accent"
                disabled={disabled}
                placeholder="Reply or add others with @"
                value={replyDrafts[commentId] ?? ''}
                onChange={(event) =>
                  setReplyDrafts((current) => ({
                    ...current,
                    [commentId]: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === 'Enter'
                  ) {
                    event.preventDefault()
                    submitReply(commentId)
                  }
                }}
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="rounded-nb-sm bg-nb-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  disabled={disabled || !(replyDrafts[commentId] ?? '').trim()}
                  onClick={() => submitReply(commentId)}
                >
                  Reply
                </button>
              </div>
            </article>
          )
        })}
        {comments.length === 0 && (
          <div className="rounded-nb-sm border border-dashed border-nb-border bg-white p-3 text-sm text-nb-text-muted">
            No comments yet. Start a discussion about this suggestion.
          </div>
        )}
      </div>
      <div className="border-t border-nb-border bg-nb-surface-1 p-4">
        <textarea
          aria-label="New suggestion comment"
          className="h-20 w-full resize-none rounded-nb-sm border border-nb-border bg-white p-2 text-sm text-nb-text outline-none focus:border-nb-accent"
          disabled={disabled}
          placeholder="Comment on this suggestion"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              submitComment()
            }
          }}
        />
        <div
          id="suggestion-new-comment-actions"
          className="mt-2 flex items-center justify-between"
        >
          <span className="text-[11px] text-nb-text-faint">
            ⌘/Ctrl Enter to send
          </span>
          <button
            type="button"
            className="rounded-nb-sm bg-nb-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            disabled={disabled || !draft.trim()}
            onClick={submitComment}
          >
            Comment
          </button>
        </div>
      </div>
    </section>
  )
}

/** Render and review operation-log changes as navigable notebook suggestions. */
export function OperationLogSuggestionView({
  docUri,
  store,
  readOnly,
  onClose,
}: {
  docUri: string
  store: LocalNotebooks
  readOnly: boolean
  onClose: () => void
}) {
  const [suggestions, setSuggestions] = useState<OperationLogSuggestion[]>([])
  const [comments, setComments] = useState<DriveComment[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    const [content, nextComments] = await Promise.all([
      store.loadContent(docUri),
      store.listOperationLogComments(docUri),
    ])
    const parsed = parseOperationLog(content)
    const nextSuggestions = buildOperationLogSuggestions(parsed.operations)
    setSuggestions(nextSuggestions)
    setComments(nextComments)
    setIndex((current) =>
      Math.min(current, Math.max(nextSuggestions.length - 1, 0))
    )
    setError(undefined)
    return parsed
  }, [docUri, store])

  useEffect(() => {
    void load().catch((loadError) => setError(String(loadError)))
    const onSync = (event: Event) => {
      const uri = (event as CustomEvent<{ uri?: string }>).detail?.uri
      if (uri === docUri) {
        void load().catch((loadError) => setError(String(loadError)))
      }
    }
    window.addEventListener('local-notebook-sync-updated', onSync)
    return () =>
      window.removeEventListener('local-notebook-sync-updated', onSync)
  }, [docUri, load])

  const suggestion = suggestions[index]
  const suggestionComments = useMemo(
    () =>
      suggestion
        ? comments.filter(
            (comment) =>
              parseSuggestionCommentAnchor(comment.anchor) === suggestion.id
          )
        : [],
    [comments, suggestion]
  )

  const review = async (decision: SuggestionDecision) => {
    if (!suggestion) return
    setBusy(true)
    const notebookData = getNotebookDataController().getNotebookData(docUri)
    const wasReviewPending = notebookData?.isReviewPending() ?? false
    try {
      // Lock the neighboring editor synchronously, before the first await, so
      // no user edit can land between the flush and rematerialization.
      notebookData?.setReviewPending(true)
      // The editor stays mounted in a neighboring tab. Flush its debounced
      // journal before appending a review so rematerialization cannot replace
      // an edit that has not reached the operation log yet.
      await notebookData?.flushPendingPersist?.()
      await store.reviewOperationLogSuggestion(
        docUri,
        suggestion.id,
        decision,
        suggestion.operationIds
      )
      const parsed = await load()
      if (notebookData) {
        // A review changes the materialized snapshot without going through the
        // editor save adapter. Replace the adapter so its comparison baseline
        // and observed operation set both match the reviewed journal.
        const saveStore = await store.createOperationLogSaveStore(docUri)
        notebookData.setNotebookStore(saveStore)
        notebookData.loadNotebook(
          materializedLogToNotebook(materializeOperationLog(parsed.operations)),
          { persist: false }
        )
      }
      showToast({
        tone: 'success',
        message:
          decision === 'accept'
            ? 'Suggestion accepted.'
            : 'Suggestion rejected.',
      })
    } catch (reviewError) {
      setError(String(reviewError))
    } finally {
      if (notebookData && !wasReviewPending) {
        notebookData.setReviewPending(false)
      }
      setBusy(false)
    }
  }

  const addComment = async (content: string) => {
    if (!suggestion) return
    setBusy(true)
    try {
      await store.addOperationLogComment(docUri, {
        content,
        anchor: createSuggestionCommentAnchor(suggestion.id),
        motivation: 'suggesting',
      })
      await load()
    } catch (commentError) {
      showToast({
        tone: 'error',
        message: `Could not add suggestion comment: ${String(commentError)}`,
      })
      throw commentError
    } finally {
      setBusy(false)
    }
  }

  const reply = async (commentId: string, content: string) => {
    setBusy(true)
    try {
      await store.replyToOperationLogComment(docUri, commentId, content)
      await load()
    } catch (replyError) {
      showToast({
        tone: 'error',
        message: `Could not reply to suggestion comment: ${String(replyError)}`,
      })
      throw replyError
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div
        id="suggestion-load-error"
        className="rounded-nb-sm border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        <p>Could not load suggestions: {error}</p>
        <Button className="mt-3" size="1" variant="soft" onClick={onClose}>
          Return to notebook
        </Button>
      </div>
    )
  }

  return (
    <div
      id="operation-log-suggestion-view"
      className="flex h-full min-w-0 flex-1 bg-white"
    >
      <aside
        id="suggestion-review-panel"
        className="flex h-full w-[340px] shrink-0 flex-col border-r border-nb-border bg-nb-surface-1"
        aria-label="Suggestion review"
      >
        <header className="border-b border-nb-border px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <Text as="p" size="2" weight="bold">
                Suggestions
              </Text>
              <Text as="p" size="1" color="gray">
                Review notebook changes
              </Text>
            </div>
            <Button size="1" variant="outline" onClick={onClose}>
              Edit view
            </Button>
          </div>
        </header>
        <nav
          id="suggestion-navigation"
          className="border-b border-nb-border px-4 py-3"
          aria-label="Suggestion navigation"
        >
          <div
            id="suggestion-navigation-pagination"
            className="flex items-center justify-between gap-2"
          >
            <Button
              size="1"
              variant="soft"
              aria-label="Previous suggestion"
              disabled={index === 0 || suggestions.length === 0}
              onClick={() => setIndex((current) => Math.max(0, current - 1))}
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </Button>
            <span className="min-w-24 text-center text-sm font-medium text-nb-text">
              {suggestions.length === 0
                ? 'No suggestions'
                : `${index + 1} of ${suggestions.length}`}
            </span>
            <Button
              size="1"
              variant="soft"
              aria-label="Next suggestion"
              disabled={index >= suggestions.length - 1}
              onClick={() =>
                setIndex((current) =>
                  Math.min(suggestions.length - 1, current + 1)
                )
              }
            >
              <ChevronRightIcon className="h-4 w-4" />
            </Button>
          </div>
          {suggestion && (
            <div id="suggestion-summary" className="mt-3">
              <Text as="p" size="2" weight="bold">
                {summary(suggestion)}
              </Text>
              <Text as="p" size="1" color="gray">
                {suggestion.actorId} ·{' '}
                {new Date(suggestion.createdAt).toLocaleString()}
              </Text>
            </div>
          )}
          <div
            id="suggestion-navigation-actions"
            className="mt-3 flex items-center gap-2"
          >
            {suggestion?.decision && (
              <Badge color={suggestion.decision === 'accept' ? 'green' : 'red'}>
                {suggestion.decision === 'accept' ? 'Accepted' : 'Rejected'}
              </Badge>
            )}
            <Button
              size="1"
              color="green"
              variant="soft"
              disabled={
                !suggestion ||
                busy ||
                readOnly ||
                suggestion.decision === 'accept'
              }
              onClick={() => void review('accept')}
            >
              <CheckIcon className="h-4 w-4" /> Accept
            </Button>
            <Button
              size="1"
              color="red"
              variant="soft"
              disabled={
                !suggestion ||
                busy ||
                readOnly ||
                suggestion.decision === 'reject'
              }
              onClick={() => void review('reject')}
            >
              <XMarkIcon className="h-4 w-4" /> Reject
            </Button>
          </div>
        </nav>
        {suggestion && (
          <SuggestionComments
            key={suggestion.id}
            comments={suggestionComments}
            disabled={busy || readOnly}
            onComment={addComment}
            onReply={reply}
          />
        )}
      </aside>

      <main
        id="suggestion-notebook-canvas"
        className="min-w-0 flex-1 overflow-auto bg-white px-8 py-5"
      >
        {suggestion ? (
          <section id="suggestion-notebook" className="space-y-3">
            {suggestion.diff.cells.map((row, rowIndex) => (
              <article key={row.id} id={`suggestion-row-${rowIndex}`}>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-nb-text-muted">
                  {cellLabel(row)} · {row.kind}
                </p>
                <ChangedCell row={row} />
              </article>
            ))}
            {suggestion.diff.cells.length === 0 && (
              <div
                id="suggestion-metadata-only"
                className="rounded-nb-sm border border-nb-border p-4 text-sm text-nb-text-muted"
              >
                This suggestion changes notebook metadata but not visible cell
                content.
              </div>
            )}
          </section>
        ) : (
          <div
            id="suggestion-empty-state"
            className="rounded-nb-sm border border-nb-border p-6 text-center text-sm text-nb-text-muted"
          >
            Edit the notebook to create its first suggestion.
          </div>
        )}
      </main>
    </div>
  )
}
