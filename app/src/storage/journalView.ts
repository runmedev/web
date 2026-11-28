import {
  type ParsedOperationLog,
  materializeOperationLog,
  materializedLogToNotebook,
} from '../lib/operationLog'
import {
  editorFrontier,
  packFrontier,
} from '../lib/operationLog/editorFrontier'
import type { DriveComment } from './drive'

export function projectComments(
  parsed: ParsedOperationLog,
  materialized: ReturnType<typeof materializeOperationLog>
): DriveComment[] {
  const operations = new Map(
    parsed.operations.map((operation) => [operation.op_id, operation])
  )
  const repliesByThread = new Map<string, DriveComment['replies']>()
  for (const comment of materialized.comments) {
    if (!comment.parent_comment_id) continue
    const replies = repliesByThread.get(comment.thread_id) ?? []
    const operation = operations.get(comment.operation_id)
    const replyTarget = comment.payload.annotation.targets[0]
    replies.push({
      id: comment.comment_id,
      anchor:
        replyTarget &&
        typeof replyTarget === 'object' &&
        !Array.isArray(replyTarget) &&
        typeof replyTarget.anchor === 'string'
          ? replyTarget.anchor
          : undefined,
      content: comment.payload.body.value,
      createdTime: operation?.created_at,
      modifiedTime: operation?.created_at,
      author: {
        displayName: comment.payload.author.display_name,
        runmeAuthorKind: comment.payload.author.kind,
        runmeAuthorSource: comment.payload.author.source,
        runmeAuthenticatedPrincipal:
          comment.payload.author.authenticated_principal,
        runmeActorId: operation?.actor_id,
      },
      runmeOperationId: comment.operation_id,
    })
    repliesByThread.set(comment.thread_id, replies)
  }
  return materialized.comments.flatMap((comment) => {
    if (comment.parent_comment_id) return []
    const operation = operations.get(comment.operation_id)
    const target = comment.payload.annotation.targets[0]
    const anchor =
      target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      typeof target.anchor === 'string'
        ? target.anchor
        : undefined
    return [
      {
        id: comment.comment_id,
        content: comment.payload.body.value,
        createdTime: operation?.created_at,
        modifiedTime: operation?.created_at,
        resolved: materialized.threadStatus[comment.thread_id] === 'resolved',
        anchor,
        author: {
          displayName: comment.payload.author.display_name,
          runmeAuthorKind: comment.payload.author.kind,
          runmeAuthorSource: comment.payload.author.source,
          runmeAuthenticatedPrincipal:
            comment.payload.author.authenticated_principal,
          runmeActorId: operation?.actor_id,
        },
        replies: repliesByThread.get(comment.thread_id) ?? [],
        runmeOperationId: comment.operation_id,
      },
    ]
  })
}

/** Use the canonical materializer for transaction, rejection, visibility and
 * execution semantics. Only the current projection crosses the worker port. */
export function buildJournalView(parsed: ParsedOperationLog) {
  const state = materializeOperationLog(parsed.operations)
  const frontier = editorFrontier(parsed.operations, state)
  return {
    notebook: materializedLogToNotebook(state),
    header: parsed.header,
    frontier: frontier && packFrontier(frontier),
    comments: projectComments(parsed, state),
  }
}
export type JournalView = ReturnType<typeof buildJournalView>
