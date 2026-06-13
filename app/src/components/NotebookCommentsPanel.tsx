import { useMemo, useState } from 'react'

import type { CellCommentThread } from '../lib/notebookComments'

type CommentsStatus = 'loading' | 'available' | 'unavailable' | 'error'
type CommentsFilter = 'open' | 'resolved' | 'all'

export function NotebookCommentsPanel({
  status,
  errorMessage,
  threads,
  cellLabels,
  draftCellId,
  busy,
  onStartDraft,
  onCancelDraft,
  onCreateComment,
  onReply,
  onResolve,
  onReopen,
  onRefresh,
  onSelectCell,
}: {
  status: CommentsStatus
  errorMessage?: string
  threads: CellCommentThread[]
  cellLabels: Map<string, string>
  draftCellId: string | null
  busy: boolean
  onStartDraft: (cellId: string) => void
  onCancelDraft: () => void
  onCreateComment: (cellId: string, content: string) => Promise<void>
  onReply: (commentId: string, content: string) => Promise<void>
  onResolve: (commentId: string) => Promise<void>
  onReopen: (commentId: string) => Promise<void>
  onRefresh: () => void
  onSelectCell: (cellId: string) => void
}) {
  const [filter, setFilter] = useState<CommentsFilter>('open')
  const [draft, setDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})

  const sortedThreads = useMemo(
    () => sortCommentThreads(threads, cellLabels, filter),
    [cellLabels, filter, threads]
  )
  const counts = useMemo(
    () => ({
      open: threads.filter((thread) => !thread.comment.resolved).length,
      resolved: threads.filter((thread) => thread.comment.resolved).length,
      all: threads.length,
    }),
    [threads]
  )

  const submitDraft = () => {
    if (!draftCellId) {
      return
    }
    const content = draft.trim()
    if (!content) {
      return
    }
    void onCreateComment(draftCellId, content).then(() => {
      setDraft('')
    })
  }

  return (
    <aside
      className="hidden h-full w-[340px] shrink-0 border-l border-nb-border bg-nb-surface-1 lg:flex lg:flex-col"
      aria-label="Notebook comments"
    >
      <div className="border-b border-nb-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-nb-text">Comments</h2>
            <p className="text-xs text-nb-text-muted">
              Google Drive comment threads
            </p>
          </div>
          <button
            type="button"
            className="rounded-nb-sm border border-nb-border px-2 py-1 text-xs text-nb-text-muted hover:border-nb-accent hover:text-nb-accent"
            onClick={onRefresh}
            disabled={busy || status !== 'available'}
          >
            Refresh
          </button>
        </div>
        {status === 'available' && (
          <div
            className="mt-3 grid grid-cols-3 rounded-nb-sm border border-nb-border bg-white p-0.5"
            aria-label="Comment filter"
          >
            {(['open', 'resolved', 'all'] as CommentsFilter[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`rounded-[5px] px-2 py-1 text-xs capitalize ${
                  filter === item
                    ? 'bg-nb-accent text-white'
                    : 'text-nb-text-muted hover:bg-nb-surface-2 hover:text-nb-text'
                }`}
                onClick={() => setFilter(item)}
              >
                {item} {counts[item]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {status === 'loading' && (
          <p className="text-sm text-nb-text-muted">Loading comments...</p>
        )}
        {status === 'unavailable' && (
          <div className="rounded-nb-sm border border-dashed border-nb-border bg-white p-3 text-sm text-nb-text-muted">
            <p>Comments are available for notebooks saved in Google Drive.</p>
            <p className="mt-2 text-xs">
              Save this notebook to Drive, then reopen the Drive-backed copy to
              enable cell comments.
            </p>
          </div>
        )}
        {status === 'error' && (
          <div className="rounded-nb-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {errorMessage ?? 'Could not load comments from Google Drive.'}
          </div>
        )}
        {status === 'available' && draftCellId && (
          <form
            className="mb-3 rounded-nb-sm border border-nb-border bg-white p-3"
            onSubmit={(event) => {
              event.preventDefault()
              submitDraft()
            }}
          >
            <label className="block text-xs font-medium text-nb-text-muted">
              New comment on {cellLabels.get(draftCellId) ?? 'cell'}
            </label>
            <textarea
              className="mt-2 h-24 w-full resize-none rounded-nb-sm border border-nb-border bg-white p-2 text-sm text-nb-text outline-none focus:border-nb-accent"
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  submitDraft()
                }
              }}
              autoFocus
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-nb-sm px-2 py-1 text-xs text-nb-text-muted hover:bg-nb-surface-2"
                onClick={() => {
                  setDraft('')
                  onCancelDraft()
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-nb-sm bg-nb-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                disabled={busy || !draft.trim()}
              >
                Comment
              </button>
            </div>
          </form>
        )}
        {status === 'available' &&
          sortedThreads.length === 0 &&
          !draftCellId && (
            <div className="rounded-nb-sm border border-dashed border-nb-border bg-white p-3 text-sm text-nb-text-muted">
              {threads.length === 0
                ? 'No comments yet. Use a cell comment button to start a thread.'
                : `No ${filter} comments.`}
            </div>
          )}
        {status === 'available' && sortedThreads.length > 0 && (
          <div className="space-y-3">
            {sortedThreads.map(({ comment, cellId, orphaned }) => {
              const commentId = comment.id ?? ''
              const replyDraft = replyDrafts[commentId] ?? ''
              return (
                <article
                  key={commentId || `${comment.createdTime}-${comment.content}`}
                  className="rounded-nb-sm border border-nb-border bg-white p-3 shadow-sm"
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-medium text-nb-text">
                        {comment.author?.displayName ?? 'Commenter'}
                      </div>
                      <div className="text-[11px] text-nb-text-faint">
                        {formatDriveTime(
                          comment.modifiedTime ?? comment.createdTime
                        )}
                      </div>
                    </div>
                    <span className="rounded-full bg-nb-surface-2 px-2 py-0.5 text-[11px] text-nb-text-muted">
                      {comment.resolved ? 'Resolved' : 'Open'}
                    </span>
                  </div>
                  {cellId && !orphaned ? (
                    <button
                      type="button"
                      className="mb-2 text-left text-xs font-medium text-nb-accent hover:underline"
                      onClick={() => onSelectCell(cellId)}
                    >
                      {cellLabels.get(cellId) ?? 'Cell'}
                    </button>
                  ) : cellId && orphaned ? (
                    <div className="mb-2 text-xs font-medium text-nb-text-faint">
                      Deleted cell
                    </div>
                  ) : (
                    <div className="mb-2 text-xs text-nb-text-faint">
                      Document-level comment
                    </div>
                  )}
                  <p className="whitespace-pre-wrap text-sm text-nb-text">
                    {comment.content ?? ''}
                  </p>
                  {(comment.replies ?? []).filter((reply) => !reply.deleted)
                    .length > 0 && (
                    <div className="mt-3 space-y-2 border-l border-nb-border pl-3">
                      {(comment.replies ?? [])
                        .filter((reply) => !reply.deleted)
                        .map((reply) => (
                          <div
                            key={
                              reply.id ??
                              `${reply.createdTime}-${reply.content}`
                            }
                          >
                            <div className="text-[11px] font-medium text-nb-text-muted">
                              {reply.author?.displayName ?? 'Reply'}
                              {reply.action ? ` - ${reply.action}` : ''}
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
                  {commentId && (
                    <div className="mt-3 space-y-2">
                      {!comment.resolved && (
                        <>
                          <textarea
                            className="h-16 w-full resize-none rounded-nb-sm border border-nb-border bg-white p-2 text-xs text-nb-text outline-none focus:border-nb-accent"
                            placeholder="Reply"
                            value={replyDraft}
                            disabled={busy}
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
                                const content = replyDraft.trim()
                                if (content) {
                                  void onReply(commentId, content).then(() => {
                                    setReplyDrafts((current) => ({
                                      ...current,
                                      [commentId]: '',
                                    }))
                                  })
                                }
                              }
                            }}
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="rounded-nb-sm px-2 py-1 text-xs text-nb-text-muted hover:bg-nb-surface-2"
                              disabled={busy}
                              onClick={() => {
                                void onResolve(commentId)
                              }}
                            >
                              Resolve
                            </button>
                            <button
                              type="button"
                              className="rounded-nb-sm bg-nb-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                              disabled={busy || !replyDraft.trim()}
                              onClick={() => {
                                const content = replyDraft.trim()
                                if (!content) {
                                  return
                                }
                                void onReply(commentId, content).then(() => {
                                  setReplyDrafts((current) => ({
                                    ...current,
                                    [commentId]: '',
                                  }))
                                })
                              }}
                            >
                              Reply
                            </button>
                          </div>
                        </>
                      )}
                      {comment.resolved && (
                        <button
                          type="button"
                          className="rounded-nb-sm border border-nb-border px-2 py-1 text-xs text-nb-text-muted hover:border-nb-accent hover:text-nb-accent"
                          disabled={busy}
                          onClick={() => {
                            void onReopen(commentId)
                          }}
                        >
                          Reopen
                        </button>
                      )}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
        {status === 'available' && !draftCellId && cellLabels.size > 0 && (
          <div className="mt-4 border-t border-nb-border pt-3">
            <label className="block text-xs font-medium text-nb-text-muted">
              Start a new thread
            </label>
            <select
              className="mt-2 w-full rounded-nb-sm border border-nb-border bg-white px-2 py-1 text-sm text-nb-text"
              defaultValue=""
              onChange={(event) => {
                if (!event.target.value) {
                  return
                }
                onStartDraft(event.target.value)
                event.target.value = ''
              }}
            >
              <option value="">Select a cell</option>
              {[...cellLabels.entries()].map(([cellId, label]) => (
                <option key={cellId} value={cellId}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </aside>
  )
}

function sortCommentThreads(
  threads: CellCommentThread[],
  cellLabels: Map<string, string>,
  filter: CommentsFilter
): CellCommentThread[] {
  return threads
    .filter((thread) => {
      if (filter === 'all') {
        return true
      }
      return filter === 'resolved'
        ? Boolean(thread.comment.resolved)
        : !thread.comment.resolved
    })
    .sort((a, b) => {
      const aGroup = threadGroup(a)
      const bGroup = threadGroup(b)
      if (aGroup !== bGroup) {
        return aGroup - bGroup
      }

      const aIndex = a.cellId ? cellIndex(cellLabels, a.cellId) : Infinity
      const bIndex = b.cellId ? cellIndex(cellLabels, b.cellId) : Infinity
      if (aIndex !== bIndex) {
        return aIndex - bIndex
      }

      return (
        b.comment.modifiedTime ??
        b.comment.createdTime ??
        ''
      ).localeCompare(a.comment.modifiedTime ?? a.comment.createdTime ?? '')
    })
}

function threadGroup(thread: CellCommentThread): number {
  if (thread.cellId && !thread.orphaned) {
    return 0
  }
  if (thread.orphaned) {
    return 1
  }
  return 2
}

function cellIndex(cellLabels: Map<string, string>, cellId: string): number {
  let index = 0
  for (const [knownCellId] of cellLabels) {
    if (knownCellId === cellId) {
      return index
    }
    index += 1
  }
  return Infinity
}

function formatDriveTime(value?: string): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}
