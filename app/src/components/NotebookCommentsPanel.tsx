import { useEffect, useMemo, useState } from 'react'

import type { CellCommentThread } from '../lib/notebookComments'

type CommentsStatus = 'loading' | 'available' | 'unavailable' | 'error'
type CommentsFilter = 'open' | 'resolved' | 'all'
type CommentsPanelItem = {
  type: 'thread'
  key: string
  cellId: string | null
  orphaned: boolean
  threads: CellCommentThread[]
  draftCellId?: string
}

export function NotebookCommentsPanel({
  status,
  errorMessage,
  threads,
  cellLabels,
  activeCellId,
  draftCellId,
  busy,
  onCancelDraft,
  onCreateComment,
  onReply,
  onResolve,
  onReopen,
  onRefresh,
  onHide,
  onSelectCell,
}: {
  status: CommentsStatus
  errorMessage?: string
  threads: CellCommentThread[]
  cellLabels: Map<string, string>
  activeCellId?: string | null
  draftCellId: string | null
  busy: boolean
  onCancelDraft: () => void
  onCreateComment: (cellId: string, content: string) => Promise<void>
  onReply: (commentId: string, content: string) => Promise<void>
  onResolve: (commentId: string) => Promise<void>
  onReopen: (commentId: string) => Promise<void>
  onRefresh: () => void
  onHide: () => void
  onSelectCell: (cellId: string) => void
}) {
  const [filter, setFilter] = useState<CommentsFilter>('open')
  const [draft, setDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [activeThreadKey, setActiveThreadKey] = useState<string | null>(null)

  const sortedThreads = useMemo(
    () => sortCommentThreads(threads, cellLabels, filter),
    [cellLabels, filter, threads]
  )
  const panelItems = useMemo(
    () => sortCommentPanelItems(sortedThreads, cellLabels, draftCellId),
    [cellLabels, draftCellId, sortedThreads]
  )
  const counts = useMemo(
    () => ({
      open: threads.filter((thread) => !thread.comment.resolved).length,
      resolved: threads.filter((thread) => thread.comment.resolved).length,
      all: threads.length,
    }),
    [threads]
  )
  const activeCellThreadKey = useMemo(() => {
    if (!activeCellId) {
      return null
    }
    const activeItem = panelItems.find(
      (item) => item.cellId === activeCellId && !item.orphaned
    )
    return activeItem?.key ?? null
  }, [activeCellId, panelItems])

  useEffect(() => {
    const visibleKeys = new Set(panelItems.map((item) => item.key))
    const firstThreadKey = panelItems[0]?.key ?? null
    const nextActiveThreadKey =
      activeCellThreadKey ??
      (activeThreadKey && visibleKeys.has(activeThreadKey)
        ? activeThreadKey
        : firstThreadKey)

    if (nextActiveThreadKey !== activeThreadKey) {
      setActiveThreadKey(nextActiveThreadKey)
    }
  }, [activeCellThreadKey, activeThreadKey, panelItems])

  const submitDraft = () => {
    if (!draftCellId) {
      return
    }
    const content = draft.trim()
    if (!content) {
      return
    }
    const targetCommentId = findReplyTargetCommentId(
      sortedThreads.filter(
        (thread) => thread.cellId === draftCellId && !thread.orphaned
      )
    )
    const submit = targetCommentId
      ? onReply(targetCommentId, content).then(onCancelDraft)
      : onCreateComment(draftCellId, content)
    void submit.then(() => setDraft(''))
  }

  const submitThreadReply = (item: CommentsPanelItem) => {
    const content = (replyDrafts[item.key] ?? '').trim()
    if (!content) {
      return
    }
    const targetCommentId = findReplyTargetCommentId(item.threads)
    const submit = targetCommentId
      ? onReply(targetCommentId, content)
      : item.cellId && !item.orphaned
        ? onCreateComment(item.cellId, content)
        : Promise.resolve()
    void submit.then(() => {
      setReplyDrafts((current) => ({ ...current, [item.key]: '' }))
    })
  }

  const resolveThread = (item: CommentsPanelItem) => {
    const commentIds = item.threads
      .filter((thread) => !thread.comment.resolved && thread.comment.id)
      .map((thread) => thread.comment.id as string)
    void Promise.all(commentIds.map((commentId) => onResolve(commentId)))
  }

  const reopenThread = (item: CommentsPanelItem) => {
    const commentIds = item.threads
      .filter((thread) => thread.comment.resolved && thread.comment.id)
      .map((thread) => thread.comment.id as string)
    void Promise.all(commentIds.map((commentId) => onReopen(commentId)))
  }

  return (
    <aside
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-nb-border bg-nb-surface-1"
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-nb-sm border border-nb-border px-2 py-1 text-xs text-nb-text-muted hover:border-nb-accent hover:text-nb-accent"
              onClick={onRefresh}
              disabled={busy || status !== 'available'}
            >
              Refresh
            </button>
            <button
              type="button"
              className="rounded-nb-sm border border-nb-border px-2 py-1 text-xs text-nb-text-muted hover:border-nb-accent hover:text-nb-accent"
              onClick={onHide}
            >
              Hide
            </button>
          </div>
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
        {status === 'available' &&
          sortedThreads.length === 0 &&
          !draftCellId && (
            <div className="rounded-nb-sm border border-dashed border-nb-border bg-white p-3 text-sm text-nb-text-muted">
              {threads.length === 0
                ? 'No comments yet. Use a cell comment button to start a thread.'
                : `No ${filter} comments.`}
            </div>
          )}
        {status === 'available' && panelItems.length > 0 && (
          <div className="space-y-3">
            {panelItems.map((item) => {
              const openThreads = item.threads.filter(
                (thread) => !thread.comment.resolved
              )
              const resolvedThreads = item.threads.filter(
                (thread) => thread.comment.resolved
              )
              const isActiveThread =
                activeThreadKey === item.key ||
                Boolean(
                  activeCellId &&
                    activeCellId === item.cellId &&
                    !item.orphaned
                )
              const isActiveCell = Boolean(
                activeCellId && item.cellId === activeCellId && !item.orphaned
              )
              const canEditThread = isActiveThread && !item.draftCellId
              const replyDraft = replyDrafts[item.key] ?? ''

              return (
                <article
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  aria-current={isActiveThread ? 'true' : undefined}
                  data-comment-cell-id={item.cellId ?? undefined}
                  data-comment-panel-item="thread"
                  className={`relative rounded-nb-sm border bg-white p-3 text-left transition-all ${
                    isActiveThread
                      ? 'border-nb-accent shadow-nb-lg ring-1 ring-nb-accent/20'
                      : 'border-nb-border shadow-sm hover:border-nb-border-strong'
                  }`}
                  onClick={() => {
                    setActiveThreadKey(item.key)
                    if (item.cellId && !item.orphaned) {
                      onSelectCell(item.cellId)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (isInteractiveTarget(event.target)) {
                      return
                    }
                    if (event.key !== 'Enter' && event.key !== ' ') {
                      return
                    }
                    event.preventDefault()
                    setActiveThreadKey(item.key)
                    if (item.cellId && !item.orphaned) {
                      onSelectCell(item.cellId)
                    }
                  }}
                >
                  {isActiveThread && (
                    <div className="absolute bottom-3 left-0 top-3 w-1 rounded-r-full bg-nb-accent" />
                  )}

                  <div className="mb-3 flex items-start justify-between gap-2">
                    <ThreadLocation
                      item={item}
                      cellLabels={cellLabels}
                      isActiveCell={isActiveCell}
                      onSelectCell={() => {
                        if (item.cellId && !item.orphaned) {
                          setActiveThreadKey(item.key)
                          onSelectCell(item.cellId)
                        }
                      }}
                    />
                    <div className="flex items-center gap-1">
                      {isActiveThread && (
                        <span className="rounded-full bg-nb-accent-soft px-2 py-0.5 text-[11px] font-medium text-nb-accent">
                          Active
                        </span>
                      )}
                      <span className="rounded-full bg-nb-surface-2 px-2 py-0.5 text-[11px] text-nb-text-muted">
                        {openThreads.length > 0
                          ? `Open ${openThreads.length}`
                          : `Resolved ${resolvedThreads.length}`}
                      </span>
                    </div>
                  </div>

                  {item.threads.length > 0 && (
                    <div className="space-y-3">
                      {item.threads.map((thread, index) => (
                        <CommentMessage
                          key={getThreadKey(thread)}
                          thread={thread}
                          showStatus={item.threads.length > 1}
                          separated={index > 0}
                        />
                      ))}
                    </div>
                  )}

                  {item.draftCellId && (
                    <form
                      aria-current={isActiveThread ? 'true' : undefined}
                      data-comment-panel-item="draft"
                      className="mt-3 border-t border-nb-border pt-3"
                      onSubmit={(event) => {
                        event.preventDefault()
                        submitDraft()
                      }}
                    >
                      <label className="block text-xs font-medium text-nb-text-muted">
                        New comment on{' '}
                        {cellLabels.get(item.draftCellId) ?? 'cell'}
                      </label>
                      <textarea
                        className="mt-2 h-24 w-full resize-none rounded-nb-sm border border-nb-border bg-white p-2 text-sm text-nb-text outline-none focus:border-nb-accent"
                        value={draft}
                        disabled={busy}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            (event.metaKey || event.ctrlKey) &&
                            event.key === 'Enter'
                          ) {
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

                  {canEditThread && (
                    <div className="mt-3 space-y-2 border-t border-nb-border pt-3">
                      {openThreads.length > 0 && (
                        <textarea
                          className="h-16 w-full resize-none rounded-nb-sm border border-nb-border bg-white p-2 text-xs text-nb-text outline-none focus:border-nb-accent"
                          placeholder="Reply or add others with @"
                          value={replyDraft}
                          disabled={busy}
                          onChange={(event) =>
                            setReplyDrafts((current) => ({
                              ...current,
                              [item.key]: event.target.value,
                            }))
                          }
                          onKeyDown={(event) => {
                            if (
                              (event.metaKey || event.ctrlKey) &&
                              event.key === 'Enter'
                            ) {
                              event.preventDefault()
                              submitThreadReply(item)
                            }
                          }}
                        />
                      )}
                      <div className="flex justify-end gap-2">
                        {openThreads.length > 0 && (
                          <button
                            type="button"
                            className="rounded-nb-sm px-2 py-1 text-xs text-nb-text-muted hover:bg-nb-surface-2"
                            disabled={busy}
                            onClick={(event) => {
                              event.stopPropagation()
                              resolveThread(item)
                            }}
                          >
                            Resolve
                          </button>
                        )}
                        {openThreads.length > 0 && (
                          <button
                            type="button"
                            className="rounded-nb-sm bg-nb-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                            disabled={busy || !replyDraft.trim()}
                            onClick={(event) => {
                              event.stopPropagation()
                              submitThreadReply(item)
                            }}
                          >
                            Reply
                          </button>
                        )}
                        {openThreads.length === 0 &&
                          resolvedThreads.length > 0 && (
                            <button
                              type="button"
                              className="rounded-nb-sm border border-nb-border px-2 py-1 text-xs text-nb-text-muted hover:border-nb-accent hover:text-nb-accent"
                              disabled={busy}
                              onClick={(event) => {
                                event.stopPropagation()
                                reopenThread(item)
                              }}
                            >
                              Reopen
                            </button>
                          )}
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}

function ThreadLocation({
  item,
  cellLabels,
  isActiveCell,
  onSelectCell,
}: {
  item: CommentsPanelItem
  cellLabels: Map<string, string>
  isActiveCell: boolean
  onSelectCell: () => void
}) {
  if (item.cellId && !item.orphaned) {
    return (
      <button
        type="button"
        className={`rounded-full px-2 py-0.5 text-left text-xs font-medium ${
          isActiveCell
            ? 'bg-nb-accent-soft text-nb-accent'
            : 'text-nb-accent hover:bg-nb-accent-muted'
        }`}
        onClick={(event) => {
          event.stopPropagation()
          onSelectCell()
        }}
      >
        {cellLabels.get(item.cellId) ?? 'Cell'}
      </button>
    )
  }
  if (item.cellId && item.orphaned) {
    return (
      <div className="text-xs font-medium text-nb-text-faint">
        Deleted cell
      </div>
    )
  }
  return (
    <div className="text-xs text-nb-text-faint">Document-level comment</div>
  )
}

function CommentMessage({
  thread,
  showStatus,
  separated,
}: {
  thread: CellCommentThread
  showStatus: boolean
  separated: boolean
}) {
  const { comment } = thread
  return (
    <div
      className={separated ? 'border-t border-nb-border pt-3' : ''}
      data-comment-message
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-nb-text">
            {comment.author?.displayName ?? 'Commenter'}
          </div>
          <div className="text-[11px] text-nb-text-faint">
            {formatDriveTime(comment.modifiedTime ?? comment.createdTime)}
          </div>
        </div>
        {showStatus && (
          <span className="rounded-full bg-nb-surface-2 px-2 py-0.5 text-[11px] text-nb-text-muted">
            {comment.resolved ? 'Resolved' : 'Open'}
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap text-sm text-nb-text">
        {comment.content ?? ''}
      </p>
      {(comment.replies ?? []).filter((reply) => !reply.deleted).length >
        0 && (
        <div className="mt-3 space-y-2 border-l border-nb-border pl-3">
          {(comment.replies ?? [])
            .filter((reply) => !reply.deleted)
            .map((reply) => (
              <div key={reply.id ?? `${reply.createdTime}-${reply.content}`}>
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
    </div>
  )
}

function sortCommentThreads(
  threads: CellCommentThread[],
  cellLabels: Map<string, string>,
  filter: CommentsFilter
): CellCommentThread[] {
  return threads
    .map((thread, originalIndex) => ({ thread, originalIndex }))
    .filter((thread) => {
      const comment = thread.thread.comment
      if (filter === 'all') {
        return true
      }
      return filter === 'resolved'
        ? Boolean(comment.resolved)
        : !comment.resolved
    })
    .sort((a, b) => {
      const aGroup = threadGroup(a.thread)
      const bGroup = threadGroup(b.thread)
      if (aGroup !== bGroup) {
        return aGroup - bGroup
      }

      const aIndex = a.thread.cellId
        ? cellIndex(cellLabels, a.thread.cellId)
        : Infinity
      const bIndex = b.thread.cellId
        ? cellIndex(cellLabels, b.thread.cellId)
        : Infinity
      if (aIndex !== bIndex) {
        return aIndex - bIndex
      }

      const aCreated = a.thread.comment.createdTime ?? ''
      const bCreated = b.thread.comment.createdTime ?? ''
      if (aCreated !== bCreated) {
        return aCreated.localeCompare(bCreated)
      }

      return a.originalIndex - b.originalIndex
    })
    .map(({ thread }) => thread)
}

function sortCommentPanelItems(
  sortedThreads: CellCommentThread[],
  cellLabels: Map<string, string>,
  draftCellId: string | null
): CommentsPanelItem[] {
  const items: CommentsPanelItem[] = []
  const itemsByCell = new Map<string, CommentsPanelItem>()

  sortedThreads.forEach((thread) => {
    if (thread.cellId && !thread.orphaned) {
      const key = getCellThreadKey(thread.cellId)
      let item = itemsByCell.get(key)
      if (!item) {
        item = {
          type: 'thread',
          key,
          cellId: thread.cellId,
          orphaned: false,
          threads: [],
        }
        itemsByCell.set(key, item)
        items.push(item)
      }
      item.threads.push(thread)
      return
    }

    items.push({
      type: 'thread',
      key: `thread:${getThreadKey(thread)}`,
      cellId: thread.cellId,
      orphaned: thread.orphaned,
      threads: [thread],
    })
  })

  if (!draftCellId) {
    return items
  }

  const draftKey = getCellThreadKey(draftCellId)
  const existingItem = itemsByCell.get(draftKey)
  if (existingItem) {
    existingItem.draftCellId = draftCellId
    return items
  }

  const draftIndex = cellIndex(cellLabels, draftCellId)
  const draftItem: CommentsPanelItem = {
    type: 'thread',
    key: draftKey,
    cellId: draftCellId,
    orphaned: false,
    threads: [],
    draftCellId,
  }
  const insertionIndex = items.findIndex((item) => {
    if (!item.cellId || item.orphaned) {
      return true
    }
    return cellIndex(cellLabels, item.cellId) > draftIndex
  })

  if (insertionIndex === -1) {
    return [...items, draftItem]
  }
  return [
    ...items.slice(0, insertionIndex),
    draftItem,
    ...items.slice(insertionIndex),
  ]
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

function getCellThreadKey(cellId: string): string {
  return `cell:${cellId}`
}

function getThreadKey(thread: CellCommentThread): string {
  return (
    thread.comment.id ??
    [
      thread.cellId ?? 'document',
      thread.comment.createdTime ?? '',
      thread.comment.content ?? '',
    ].join(':')
  )
}

function findReplyTargetCommentId(
  threads: CellCommentThread[]
): string | null {
  const openThreads = threads.filter(
    (thread) => !thread.comment.resolved && thread.comment.id
  )
  const candidates = openThreads.length > 0 ? openThreads : threads
  const [target] = [...candidates].sort((a, b) =>
    (b.comment.createdTime ?? '').localeCompare(a.comment.createdTime ?? '')
  )
  return target?.comment.id ?? null
}

function isInteractiveTarget(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'button, textarea, input, select, a, [contenteditable="true"]'
      )
    )
  )
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
