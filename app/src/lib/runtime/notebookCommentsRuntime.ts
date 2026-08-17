import type { parser_pb } from '../../runme/client'
import type { DriveNotebookStore } from '../../storage/drive'
import { isDriveItemUri } from '../../storage/drive'
import type { LocalNotebooks } from '../../storage/local'
import type { LocalComments } from '../../storage/localComments'
import {
  buildRenderedMarkdownProjection,
  sourceRangesForProjectionRange,
} from '../markdown/renderedMarkdownProjection'
import {
  type CommentAnchor,
  type CommentLocationState,
  parseCommentAnchor,
  resolveRenderedTextAnchor,
  toCellCommentThreads,
} from '../notebookComments'
import type { NotebookDataLike } from './runmeConsole'

type CommentStatusFilter = 'open' | 'resolved' | 'all'

export type ListNotebookCommentsInput = {
  target?: unknown
  status?: CommentStatusFilter
}

export type CommentMutationInput = {
  target?: unknown
  commentId: string
}

export type CommentReplyInput = CommentMutationInput & {
  content: string
}

export type AgentAnnotation = {
  id: string | null
  content: string
  resolved: boolean
  sync: {
    status: 'pending' | 'syncing' | 'uncertain' | 'synced' | 'failed'
    error?: string
  }
  replies: unknown[]
  anchor: CommentAnchor | null
  originalTarget: {
    cellId: string
    surface: 'cell' | 'rendered-markdown'
    revision: string | null
    selectors: unknown[]
    reviewedContent: string | null
  } | null
  editableSource: {
    cellId: string
    content: string
    ranges: Array<{ start: number; end: number }>
    confidence: 'exact' | 'derived' | 'unavailable'
  } | null
  currentResolution: CommentLocationState | null
}

function findCell(
  notebook: parser_pb.Notebook,
  cellId: string | null
): parser_pb.Cell | null {
  if (!cellId) {
    return null
  }
  return notebook.cells.find((cell) => cell.refId === cellId) ?? null
}

async function remoteUriForNotebook(args: {
  uri: string
  localNotebooks: LocalNotebooks | null
}): Promise<string | null> {
  if (isDriveItemUri(args.uri)) {
    return args.uri
  }
  if (!args.uri.startsWith('local://') || !args.localNotebooks) {
    return null
  }
  const metadata = await args.localNotebooks.getMetadata(args.uri)
  return metadata?.remoteUri && isDriveItemUri(metadata.remoteUri)
    ? metadata.remoteUri
    : null
}

type NotebookCommentsRuntimeDependencies = {
  resolveNotebook: (target?: unknown) => NotebookDataLike | null
  resolveLocalNotebooks: () => LocalNotebooks | null
  resolveDriveNotebookStore: () => DriveNotebookStore | null
  resolveLocalComments?: () => LocalComments | null
}

async function resolveCommentsContext(
  dependencies: NotebookCommentsRuntimeDependencies,
  target?: unknown
): Promise<{
  notebookData: NotebookDataLike
  driveNotebookStore: DriveNotebookStore
  remoteUri: string
  notebookUri: string
  localComments: LocalComments | null
}> {
  const notebookData = dependencies.resolveNotebook(target)
  if (!notebookData) {
    throw new Error('The target notebook is not open.')
  }
  const driveNotebookStore = dependencies.resolveDriveNotebookStore()
  if (!driveNotebookStore) {
    throw new Error('Google Drive comments are unavailable.')
  }
  const remoteUri = await remoteUriForNotebook({
    uri: notebookData.getUri(),
    localNotebooks: dependencies.resolveLocalNotebooks(),
  })
  if (!remoteUri) {
    throw new Error('Notebook is not backed by a Google Drive file.')
  }
  return {
    notebookData,
    driveNotebookStore,
    remoteUri,
    notebookUri: notebookData.getUri(),
    localComments: dependencies.resolveLocalComments?.() ?? null,
  }
}

export async function listNotebookComments(
  dependencies: NotebookCommentsRuntimeDependencies,
  input: ListNotebookCommentsInput = {}
): Promise<AgentAnnotation[]> {
  const { notebookData, driveNotebookStore, remoteUri, localComments } =
    await resolveCommentsContext(dependencies, input.target)
  const comments = localComments
    ? await localComments.list(remoteUri)
    : await driveNotebookStore.listComments(remoteUri)
  if (localComments) {
    void localComments.reconcile(remoteUri).catch(() => undefined)
  }
  const notebook = notebookData.getNotebook()
  const identities = notebook.cells.map((cell) => ({
    refId: cell.refId,
    value: cell.value,
    metadata: cell.metadata,
  }))
  const filter = input.status ?? 'open'
  return toCellCommentThreads(comments, identities)
    .filter((thread) => {
      if (filter === 'all') {
        return true
      }
      return filter === 'resolved'
        ? Boolean(thread.comment.resolved)
        : !thread.comment.resolved
    })
    .map((thread) => {
      const anchor = parseCommentAnchor(thread.comment.anchor)
      const cell = findCell(notebook, thread.cellId)
      const sourceRanges =
        cell &&
        anchor?.type === 'cell-text' &&
        thread.location &&
        (thread.location.status === 'exact' ||
          thread.location.status === 'moved')
          ? sourceRangesForProjectionRange(
              buildRenderedMarkdownProjection(cell.value),
              cell.value,
              thread.location.start,
              thread.location.end
            )
          : []
      return {
        id: thread.comment.id ?? null,
        content: thread.comment.content ?? '',
        resolved: Boolean(thread.comment.resolved),
        sync: {
          status: thread.comment.runmeSyncStatus ?? 'synced',
          ...(thread.comment.runmeSyncError
            ? { error: thread.comment.runmeSyncError }
            : {}),
        },
        replies: thread.comment.replies ?? [],
        anchor,
        originalTarget: anchor
          ? {
              cellId: anchor.cellId,
              surface: anchor.type === 'cell' ? 'cell' : 'rendered-markdown',
              revision:
                anchor.type === 'cell-text'
                  ? anchor.state.driveRevisionId
                  : null,
              selectors: anchor.type === 'cell-text' ? anchor.selectors : [],
              reviewedContent:
                anchor.type === 'cell-text' ? anchor.selectors[1].exact : null,
            }
          : null,
        editableSource:
          cell && anchor
            ? {
                cellId: cell.refId,
                content: cell.value,
                ranges: sourceRanges,
                confidence:
                  anchor.type === 'cell-text' && sourceRanges.length > 0
                    ? 'derived'
                    : anchor.type === 'cell'
                      ? 'exact'
                      : 'unavailable',
              }
            : null,
        currentResolution: thread.location,
      } satisfies AgentAnnotation
    })
}

export function resolveCommentAnchor(args: {
  anchor: string
  source: string
}): {
  anchor: CommentAnchor
  currentResolution: CommentLocationState
  editableSourceRanges: Array<{ start: number; end: number }>
} {
  const anchor = parseCommentAnchor(args.anchor)
  if (!anchor) {
    throw new Error('The comment anchor is not a valid Runme anchor.')
  }
  if (anchor.type === 'cell') {
    return {
      anchor,
      currentResolution: { status: 'cell' },
      editableSourceRanges: [],
    }
  }
  const currentResolution = resolveRenderedTextAnchor(anchor, args.source)
  const editableSourceRanges =
    currentResolution.status === 'exact' || currentResolution.status === 'moved'
      ? sourceRangesForProjectionRange(
          buildRenderedMarkdownProjection(args.source),
          args.source,
          currentResolution.start,
          currentResolution.end
        )
      : []
  return { anchor, currentResolution, editableSourceRanges }
}

export function createNotebookCommentsRuntimeApi(
  dependencies: NotebookCommentsRuntimeDependencies
) {
  return {
    list: (input: ListNotebookCommentsInput = {}) =>
      listNotebookComments(dependencies, input),
    parseAnchor: (anchor: string) => parseCommentAnchor(anchor),
    resolveAnchor: (args: { anchor: string; source: string }) =>
      resolveCommentAnchor(args),
    reply: async (input: CommentReplyInput) => {
      const { driveNotebookStore, remoteUri, notebookUri, localComments } =
        await resolveCommentsContext(dependencies, input.target)
      if (localComments) {
        const operation = await localComments.saveDesiredReply({
          notebookUri,
          remoteUri,
          commentId: input.commentId,
          content: input.content,
        })
        void localComments.reconcile(remoteUri)
        return operation
      }
      return driveNotebookStore.replyToComment(
        remoteUri,
        input.commentId,
        input.content
      )
    },
    resolve: async (input: CommentMutationInput) => {
      const { driveNotebookStore, remoteUri, notebookUri, localComments } =
        await resolveCommentsContext(dependencies, input.target)
      if (localComments) {
        const operation = await localComments.setThreadIntent(
          {
            notebookUri,
            remoteUri,
            commentId: input.commentId,
          },
          true
        )
        void localComments.reconcile(remoteUri)
        return operation
      }
      return driveNotebookStore.resolveComment(remoteUri, input.commentId)
    },
    reopen: async (input: CommentMutationInput) => {
      const { driveNotebookStore, remoteUri, notebookUri, localComments } =
        await resolveCommentsContext(dependencies, input.target)
      if (localComments) {
        const operation = await localComments.setThreadIntent(
          {
            notebookUri,
            remoteUri,
            commentId: input.commentId,
          },
          false
        )
        void localComments.reconcile(remoteUri)
        return operation
      }
      return driveNotebookStore.reopenComment(remoteUri, input.commentId)
    },
    help: () =>
      [
        'await comments.list({ target?, status? })',
        'comments.parseAnchor(anchor)',
        'comments.resolveAnchor({ anchor, source })',
        'await comments.reply({ target?, commentId, content })',
        'await comments.resolve({ target?, commentId })',
        'await comments.reopen({ target?, commentId })',
        'comments.list includes sync.status; mutations return after local persistence and reconcile asynchronously; Drive replies include a visible Runme identity footer',
      ].join('\n'),
  }
}
