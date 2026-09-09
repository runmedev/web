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
  createCellCommentAnchor,
  parseCommentAnchor,
  resolveRenderedTextAnchor,
  toCellCommentThreads,
} from '../notebookComments'
import {
  buildOperationLogSuggestions,
  parseOperationLog,
} from '../operationLog'
import {
  type ComparisonAssessment,
  type ComparisonCellDecision,
  type ComparisonComment,
  assessComparison,
  commentOnComparison,
  decideComparisonCell,
} from '../operationLog/comparisonFeedback'
import type { ComparisonSelection } from '../operationLog/comparisons'
import { type Attribution, normalizeAttribution } from '../operationLog/records'
import type {
  Anchor,
  ComparisonContext,
  VersionRef,
} from '../operationLog/records'
import type { NotebookDataLike } from './runmeConsole'

type CommentStatusFilter = 'open' | 'resolved' | 'all'

export type ListNotebookCommentsInput = {
  target?: unknown
  status?: CommentStatusFilter
}

export type CommentMutationInput = {
  target?: unknown
  commentId?: string
  thread_id?: string
}

export type CommentReplyInput = CommentMutationInput & {
  anchors?: Anchor[]
  parent_comment_id?: string
  content: string
  author?: Attribution
}

export type AgentAnnotation = {
  id: string | null
  anchors?: Anchor[]
  comparison?: ComparisonContext
  rawAnchor?: string
  author?: unknown
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
    surface: 'cell' | 'rendered-markdown' | 'diff-source'
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
  driveNotebookStore: DriveNotebookStore | null
  remoteUri: string | null
  notebookUri: string
  localComments: LocalComments | null
  operationLog: boolean
}> {
  const notebookData = dependencies.resolveNotebook(target)
  if (!notebookData) {
    throw new Error('The target notebook is not open.')
  }
  const notebookUri = notebookData.getUri()
  const localNotebooks = dependencies.resolveLocalNotebooks()
  if (
    notebookUri.startsWith('local://') &&
    localNotebooks &&
    (await localNotebooks.isOperationLogNotebook(notebookUri))
  ) {
    return {
      notebookData,
      driveNotebookStore: null,
      remoteUri: null,
      notebookUri,
      localComments: null,
      operationLog: true,
    }
  }
  const driveNotebookStore = dependencies.resolveDriveNotebookStore()
  if (!driveNotebookStore) {
    throw new Error('Google Drive comments are unavailable.')
  }
  const remoteUri = await remoteUriForNotebook({
    uri: notebookUri,
    localNotebooks,
  })
  if (!remoteUri) {
    throw new Error('Notebook is not backed by a Google Drive file.')
  }
  return {
    notebookData,
    driveNotebookStore,
    remoteUri,
    notebookUri,
    localComments: dependencies.resolveLocalComments?.() ?? null,
    operationLog: false,
  }
}

export async function listNotebookComments(
  dependencies: NotebookCommentsRuntimeDependencies,
  input: ListNotebookCommentsInput = {}
): Promise<AgentAnnotation[]> {
  const {
    notebookData,
    driveNotebookStore,
    remoteUri,
    localComments,
    operationLog,
    notebookUri,
  } = await resolveCommentsContext(dependencies, input.target)
  if (operationLog && !input.target)
    throw new Error('An explicit notebook target is required')
  const comments = operationLog
    ? await dependencies
        .resolveLocalNotebooks()!
        .listOperationLogComments(notebookUri)
    : localComments
      ? await localComments.list(remoteUri!)
      : await driveNotebookStore!.listComments(remoteUri!)
  if (!operationLog && localComments) {
    void localComments.reconcile(remoteUri!).catch(() => undefined)
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
      let native: { anchors?: Anchor[]; comparison?: ComparisonContext } = {}
      try {
        const projected = JSON.parse(thread.comment.anchor ?? '{}').runme
        if (Array.isArray(projected?.anchors))
          native = {
            anchors: projected.anchors,
            comparison: projected.comparison,
          }
      } catch {
        /* Legacy or non-Runme anchors need no native projection. */
      }
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
        ...native,
        rawAnchor: thread.comment.anchor,
        author: thread.comment.author,
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
              surface:
                anchor.type === 'cell'
                  ? anchor.diffTarget
                    ? 'diff-source'
                    : 'cell'
                  : 'rendered-markdown',
              revision:
                anchor.type === 'cell-text'
                  ? anchor.state.driveRevisionId
                  : null,
              selectors:
                anchor.type === 'cell-text'
                  ? anchor.selectors
                  : anchor.diffTarget
                    ? [anchor.diffTarget]
                    : [],
              reviewedContent:
                anchor.type === 'cell-text'
                  ? anchor.selectors[1].exact
                  : (anchor.quote ?? null),
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
                    : anchor.type === 'cell' && !anchor.quote
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
  // The UI disables these actions too, but agent/API callers must not bypass
  // notebook ownership or an in-progress release by invoking the runtime.
  const assertWritable = (notebookData: NotebookDataLike) => {
    if (notebookData.isReadOnly?.() || notebookData.isReleasePending?.())
      throw new Error('Notebook is read-only or busy')
  }
  const operationContext = async (target: unknown, write = false) => {
    if (!target) throw new Error('An explicit notebook target is required')
    const context = await resolveCommentsContext(dependencies, target)
    if (!context.operationLog)
      throw new Error('Comparison APIs require a .runme notebook')
    if (write) assertWritable(context.notebookData)
    return { ...context, store: dependencies.resolveLocalNotebooks()! }
  }
  const suggestions = {
    list: async (input: { target: unknown }) => {
      const context = await operationContext(input.target)
      return buildOperationLogSuggestions(
        parseOperationLog(await context.store.loadContent(context.notebookUri))
          .operations
      )
    },
  }
  const comparisons = {
    help: () =>
      [
        'comparisons.preview({target,start,end,cell_ids?}) accepts VersionRefs and is read-only; picker wrappers may use startRevisionId/endRevisionId/cellIds.',
        'comparisons.comment({...selection,content,cellId?,side?,sourceRange?,author?})',
        'comparisons.assess({...selection,outcome:good_enough|needs_more_work,author?})',
        'comparisons.decideCell({...selection,cellId,decision:accept|undo,author?})',
        'comparisons.list({target}) derives conversations from comments; no Review records.',
      ].join('\n'),
    list: async (input: { target: unknown }) => {
      const c = await operationContext(input.target)
      return c.store.listNotebookComparisons(c.notebookUri)
    },
    comment: async (input: ComparisonComment & { target: unknown }) => {
      const c = await operationContext(input.target, true)
      await c.notebookData.flushPendingPersist?.()
      return commentOnComparison(c.store, c.notebookUri, {
        ...input,
        author: normalizeAttribution(input.author),
      })
    },
    assess: async (input: ComparisonAssessment & { target: unknown }) => {
      const c = await operationContext(input.target, true)
      await c.notebookData.flushPendingPersist?.()
      return assessComparison(c.store, c.notebookUri, {
        ...input,
        author: normalizeAttribution(input.author),
      })
    },
    decideCell: async (input: ComparisonCellDecision & { target: unknown }) => {
      const c = await operationContext(input.target, true)
      return decideComparisonCell(
        c.store,
        c.notebookUri,
        { ...input, author: normalizeAttribution(input.author) },
        c.notebookData
      )
    },
    preview: async (input: ComparisonSelection & { target: unknown }) => {
      const c = await operationContext(input.target)
      return c.store.previewNotebookComparison(c.notebookUri, input)
    },
  }
  const revisions = {
    help: () =>
      'revisions.list({target:{uri}}); revisions.create({target,snapshot_heads?,name?,description?,author?}) returns a revision VersionRef for the selected immutable snapshot (current committed head by default), without changing notebook content; revisions.label({target,revision,name,description?,author?}) labels an existing VersionRef (revisionId is a picker adapter) without changing its snapshot; revisions.migrate({target,name?}) explicitly exports a separate V2 local copy or returns migration warnings. lastChangedAt is the last content change, not label time.',
    list: async (input: { target: unknown }) => {
      const c = await operationContext(input.target)
      await c.notebookData.flushPendingPersist?.()
      return c.store.listNotebookRevisions(c.notebookUri)
    },
    // The public API creates a revision; checkpointing is the storage mechanism.
    create: async (input: {
      target: unknown
      snapshot_heads?: string[]
      name?: string
      description?: string
      author?: Attribution
    }) => {
      const c = await operationContext(input.target, true)
      await c.notebookData.flushPendingPersist?.()
      return c.store.checkpointNotebookRevision(c.notebookUri, {
        ...input,
        author: normalizeAttribution(input.author),
      })
    },
    migrate: async (input: { target: unknown; name?: string }) => {
      const c = await operationContext(input.target, true)
      await c.notebookData.flushPendingPersist?.()
      return c.store.migrateNotebookToV2(c.notebookUri, input)
    },
    label: async (input: {
      target: unknown
      revisionId?: string
      revision?: VersionRef
      name: string
      description?: string
      author?: Attribution
    }) => {
      const c = await operationContext(input.target, true)
      return c.store.labelNotebookRevision(c.notebookUri, {
        ...input,
        author: normalizeAttribution(input.author),
      })
    },
  }
  return {
    comparisons,
    revisions,
    suggestions,
    add: async (input: {
      target: unknown
      content: string
      anchors?: Anchor[]
      comparison?: ComparisonContext
      cellId?: string
      author?: Attribution
    }) => {
      const c = await operationContext(input.target, true)
      if (!input.content.trim()) throw new Error('Comment content is required')
      await c.notebookData.flushPendingPersist?.()
      if (input.anchors)
        return c.store.addAnchoredComment(c.notebookUri, {
          anchors: input.anchors,
          comparison: input.comparison,
          content: input.content,
          author: normalizeAttribution(input.author),
        })
      if (!input.cellId)
        throw new Error('Supply explicit version-bound anchors or a cell ID')
      return c.store.addOperationLogComment(c.notebookUri, {
        content: input.content,
        anchor: createCellCommentAnchor(input.cellId),
        snapshot_heads: c.notebookData.getObservedOperationHeads?.(),
        author: normalizeAttribution(input.author),
      })
    },
    list: (input: ListNotebookCommentsInput = {}) =>
      listNotebookComments(dependencies, input),
    parseAnchor: (anchor: string) => parseCommentAnchor(anchor),
    resolveAnchor: (args: { anchor: string; source: string }) =>
      resolveCommentAnchor(args),
    reply: async (input: CommentReplyInput) => {
      const commentId = input.parent_comment_id ?? input.commentId
      if (!commentId) throw new Error('parent_comment_id is required')
      const {
        notebookData,
        driveNotebookStore,
        remoteUri,
        notebookUri,
        localComments,
        operationLog,
      } = await resolveCommentsContext(dependencies, input.target)
      assertWritable(notebookData)
      if (operationLog) {
        if (!input.target)
          throw new Error('An explicit notebook target is required')
        return dependencies
          .resolveLocalNotebooks()!
          .replyToOperationLogComment(notebookUri, commentId, input.content, {
            author: normalizeAttribution(input.author),
            ...(input.anchors ? { anchors: input.anchors } : {}),
          })
      }
      if (input.anchors)
        throw new Error('Version-bound reply anchors require a .runme notebook')
      if (input.author !== undefined)
        throw new Error(
          'Native Google Drive comment authors cannot be overridden'
        )
      if (localComments) {
        const operation = await localComments.saveDesiredReply({
          notebookUri,
          remoteUri: remoteUri!,
          commentId,
          content: input.content,
        })
        void localComments.reconcile(remoteUri!)
        return operation
      }
      return driveNotebookStore!.replyToComment(
        remoteUri!,
        commentId,
        input.content
      )
    },
    resolve: async (input: CommentMutationInput) => {
      const commentId = input.thread_id ?? input.commentId
      if (!commentId) throw new Error('thread_id is required')
      const {
        notebookData,
        driveNotebookStore,
        remoteUri,
        notebookUri,
        localComments,
        operationLog,
      } = await resolveCommentsContext(dependencies, input.target)
      assertWritable(notebookData)
      if (operationLog) {
        if (!input.target)
          throw new Error('An explicit notebook target is required')
        return dependencies
          .resolveLocalNotebooks()!
          .setOperationLogCommentResolved(notebookUri, commentId, true)
      }
      if (localComments) {
        const operation = await localComments.setThreadIntent(
          {
            notebookUri,
            remoteUri: remoteUri!,
            commentId,
          },
          true
        )
        void localComments.reconcile(remoteUri!)
        return operation
      }
      return driveNotebookStore!.resolveComment(remoteUri!, commentId)
    },
    reopen: async (input: CommentMutationInput) => {
      const commentId = input.thread_id ?? input.commentId
      if (!commentId) throw new Error('thread_id is required')
      const {
        notebookData,
        driveNotebookStore,
        remoteUri,
        notebookUri,
        localComments,
        operationLog,
      } = await resolveCommentsContext(dependencies, input.target)
      assertWritable(notebookData)
      if (operationLog) {
        if (!input.target)
          throw new Error('An explicit notebook target is required')
        return dependencies
          .resolveLocalNotebooks()!
          .setOperationLogCommentResolved(notebookUri, commentId, false)
      }
      if (localComments) {
        const operation = await localComments.setThreadIntent(
          {
            notebookUri,
            remoteUri: remoteUri!,
            commentId,
          },
          false
        )
        void localComments.reconcile(remoteUri!)
        return operation
      }
      return driveNotebookStore!.reopenComment(remoteUri!, commentId)
    },
    help: () =>
      [
        'await comments.list({ target, status? })',
        'await comments.add({ target, content, anchors?, comparison?, cellId?, author? }); anchors bind cell IDs and Unicode-code-point source ranges to operation/revision VersionRefs; no stored quote.',
        'author: { displayName, kind: human|agent|service-account|unknown }; omitted/blank API author is unknown, never the signed-in human',
        'comments.parseAnchor(anchor)',
        'comments.resolveAnchor({ anchor, source })',
        'await comments.reply({ target, parent_comment_id, content, anchors?, author? }); optional anchors add historical context; commentId remains a UI adapter',
        'await comments.resolve({ target, thread_id })',
        'await comments.reopen({ target, thread_id })',
        'comments.list includes sync.status; .runme mutations append to the operation log, while Drive mutations persist locally and reconcile asynchronously',
      ].join('\n'),
  }
}
