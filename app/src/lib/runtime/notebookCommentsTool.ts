import type { parser_pb } from '../../runme/client'
import type { DriveNotebookStore } from '../../storage/drive'
import { isDriveItemUri } from '../../storage/drive'
import type { LocalNotebooks } from '../../storage/local'
import {
  buildRenderedMarkdownProjection,
  sourceRangesForProjectionRange,
} from '../markdown/renderedMarkdownProjection'
import {
  type CommentLocationState,
  parseCommentAnchor,
  toCellCommentThreads,
} from '../notebookComments'
import type { NotebookDataLike } from './runmeConsole'

export const LIST_NOTEBOOK_COMMENTS_TOOL_NAME = 'listNotebookComments'
export const LIST_NOTEBOOK_COMMENTS_TOOL_TITLE = 'List Notebook Comments'
export const LIST_NOTEBOOK_COMMENTS_TOOL_DESCRIPTION =
  'List Google Drive comments for an open Runme notebook and resolve each annotation to the reviewed rendered-Markdown quote, editable source hints, and current target status.'

type CommentStatusFilter = 'open' | 'resolved' | 'all'

export type ListNotebookCommentsInput = {
  uri?: string
  status?: CommentStatusFilter
}

export type AgentAnnotation = {
  id: string | null
  content: string
  resolved: boolean
  replies: unknown[]
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

export function buildListNotebookCommentsInputSchema(): Record<
  string,
  unknown
> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      uri: {
        type: 'string',
        description:
          'Optional concrete local:// notebook URI. Omit to use the current notebook.',
      },
      status: {
        type: 'string',
        enum: ['open', 'resolved', 'all'],
        description: 'Comment lifecycle filter. Defaults to open.',
      },
    },
  }
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

export async function listNotebookCommentsForAgents(args: {
  input: ListNotebookCommentsInput
  currentUri: string | null
  resolveNotebook: (uri: string) => NotebookDataLike | null
  localNotebooks: LocalNotebooks | null
  driveNotebookStore: DriveNotebookStore | null
}): Promise<AgentAnnotation[]> {
  const uri = args.input.uri?.trim() || args.currentUri
  if (!uri) {
    throw new Error('No current notebook is available. Pass a concrete uri.')
  }
  const notebookData = args.resolveNotebook(uri)
  if (!notebookData) {
    throw new Error(`Notebook is not open: ${uri}`)
  }
  if (!args.driveNotebookStore) {
    throw new Error('Google Drive comments are unavailable.')
  }
  const remoteUri = await remoteUriForNotebook({
    uri,
    localNotebooks: args.localNotebooks,
  })
  if (!remoteUri) {
    throw new Error('Notebook is not backed by a Google Drive file.')
  }
  const comments = await args.driveNotebookStore.listComments(remoteUri)
  const notebook = notebookData.getNotebook()
  const identities = notebook.cells.map((cell) => ({
    refId: cell.refId,
    value: cell.value,
    metadata: cell.metadata,
  }))
  const filter = args.input.status ?? 'open'
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
        replies: thread.comment.replies ?? [],
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
