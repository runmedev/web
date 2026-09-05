import { useEffect, useRef, useState } from 'react'
import { commentAttributionLabel } from '../../lib/commentAttribution'
import {
  parseDiffCommentTarget,
  type DiffCommentTarget,
} from '../../lib/operationLog/diffCommentAnchor'
import { parseReviewAnchor } from '../../lib/operationLog/reviews'
import type { DriveComment, DriveUser } from '../../storage/drive'

/** Root and reply authorship use the same presentation. */
function Message({
  content,
  author,
  createdTime,
}: {
  content?: string
  author?: DriveUser
  createdTime?: string
}) {
  return (
    <>
      <p className="text-xs font-medium">
        {author?.displayName ?? 'unknown'} ·{' '}
        {commentAttributionLabel(author) || 'recorded author'}
      </p>
      {createdTime && (
        <time dateTime={createdTime} className="text-xs text-nb-text-muted">
          {new Date(createdTime).toLocaleString()}
        </time>
      )}
      <p className="whitespace-pre-wrap text-sm">{content}</p>
    </>
  )
}

/** Present one review-wide conversation, including legacy roots. Nothing is
 * rewritten: new messages reply to a stable root, preserving existing IDs.
 */
export function ReviewConversation({
  comments,
  disabled,
  onSend,
}: {
  comments: DriveComment[]
  disabled: boolean
  onSend: (content: string, rootId?: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const roots = [...comments].sort(
    (a, b) =>
      (a.createdTime ?? '').localeCompare(b.createdTime ?? '') ||
      (a.id ?? '').localeCompare(b.id ?? '')
  )
  const messages = roots
    .flatMap((root) => [
      root,
      ...(root.replies ?? []).filter((reply) => !reply.deleted),
    ])
    .sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))
  return (
    <section
      id="review-conversation"
      aria-label="Review discussion"
      className="my-4 border-t pt-3"
    >
      <h3 className="font-medium">Review discussion</h3>
      <div
        id="review-conversation-messages"
        className="my-2 space-y-3 rounded border bg-white p-3"
      >
        {!messages.length && (
          <p className="text-sm text-nb-text-muted">
            Discuss the review as a whole here. Comment on individual cells
            directly in the diff.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={message.id ?? index}>
            <Message {...message} />
          </div>
        ))}
      </div>
      <textarea
        aria-label="New review comment"
        disabled={disabled}
        className="min-h-20 w-full rounded border p-2 text-sm"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        className="mt-1 rounded border px-2 py-1 text-sm disabled:opacity-40"
        disabled={disabled || !draft.trim()}
        onClick={async () => {
          if (await onSend(draft, roots[0]?.id)) setDraft('')
        }}
      >
        Send review comment
      </button>
    </section>
  )
}

/** Cell threads stay next to their diff rather than in the review-wide panel. */
export function CellDiscussion({
  thread,
  disabled,
  outdated,
  onReply,
  onResolve,
}: {
  thread: DriveComment
  disabled: boolean
  outdated: boolean
  onReply: (id: string, content: string) => Promise<boolean>
  onResolve: (id: string, resolved: boolean) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const anchor = parseReviewAnchor(thread.anchor)
  const target = parseDiffCommentTarget(thread.anchor)
  return (
    <article
      id={`review-thread-${thread.id}`}
      className="my-2 rounded border border-nb-border bg-white p-3"
    >
      <p className="text-xs text-nb-text-muted">
        {thread.resolved ? 'Resolved' : 'Open'}
        {outdated ? ' · Outdated context' : ''}
        {target
          ? ` · ${target.side === 'base' ? 'Previous' : 'Proposed'} cell${target.sourceRange ? ' selection' : ''}`
          : ''}
      </p>
      {anchor?.quote && (
        <blockquote className="my-2 max-h-24 overflow-auto border-l-2 border-nb-accent pl-2 text-xs text-nb-text-muted">
          {anchor.quote}
        </blockquote>
      )}
      <Message {...thread} />
      {(thread.replies ?? [])
        .filter((reply) => !reply.deleted)
        .map((reply) => (
          <div key={reply.id} className="my-2 border-l pl-2">
            <Message {...reply} />
          </div>
        ))}
      <textarea
        aria-label={`Reply to ${thread.id}`}
        disabled={disabled}
        className="mt-2 w-full rounded border p-2 text-sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="mt-1 flex gap-2 text-sm">
        <button
          disabled={disabled || !draft.trim()}
          onClick={async () => {
            if (await onReply(thread.id!, draft)) setDraft('')
          }}
        >
          Reply
        </button>
        <button
          disabled={disabled}
          onClick={() => void onResolve(thread.id!, !thread.resolved)}
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
    </article>
  )
}

/** Capture the target before focus leaves the selected diff source. */
export function DiffCommentComposer({
  target,
  disabled,
  onSend,
  onCancel,
}: {
  target: DiffCommentTarget
  disabled: boolean
  onSend: (content: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [target])
  return (
    <section
      aria-label="New cell discussion"
      className="my-2 rounded border border-nb-accent bg-white p-3"
    >
      <blockquote className="mb-2 max-h-24 overflow-auto border-l-2 border-nb-accent pl-2 text-xs">
        {target.side === 'base' ? 'Previous' : 'Proposed'} cell
        {target.sourceRange ? ' selection' : ''}: {target.quote}
      </blockquote>
      <textarea
        ref={input}
        aria-label="New cell comment"
        disabled={disabled}
        className="min-h-20 w-full rounded border p-2 text-sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        disabled={disabled || !draft.trim()}
        className="mr-3 text-sm"
        onClick={async () => {
          if (await onSend(draft)) {
            setDraft('')
            onCancel()
          }
        }}
      >
        Add cell comment
      </button>
      <button disabled={disabled} className="text-sm" onClick={onCancel}>
        Cancel
      </button>
    </section>
  )
}
