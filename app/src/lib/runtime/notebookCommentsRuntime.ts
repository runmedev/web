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
  createSuggestionCommentAnchor,
  parseOperationLog,
} from '../operationLog'
import {
  type ComparisonAssessment,
  type ComparisonComment,
  assessComparison,
  commentOnComparison,
} from '../operationLog/comparisonFeedback'
import {
  type DiffCommentTarget,
  createDiffCommentTarget,
} from '../operationLog/diffCommentAnchor'
import {
  type Attribution,
  type ReviewOutcome,
  createReviewAnchor,
  normalizeAttribution,
} from '../operationLog/reviews'
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
  author?: Attribution
}

export type AgentAnnotation = {
  id: string | null
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
      throw new Error('Review APIs require a .runme notebook')
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
  const reviews = {
    help: () =>
      [
        'await reviews.list({ target: { uri } })',
        'await revisions.list({ target: { uri } })',
        'await revisions.label({ target: { uri }, revisionId, name, description?, author? })',
        'await reviews.preview({ target: { uri }, startRevisionId, endRevisionId, cellIds? })',
        'await reviews.comment({ target: { uri }, startRevisionId, endRevisionId, cellIds?, content, cellId?, side?, sourceRange?, author? }) — comment directly; no create step',
        'await reviews.assess({ target: { uri }, startRevisionId, endRevisionId, cellIds?, outcome, author? }) — Good Enough/Needs More Work without a submit workflow',
        'await reviews.create({ target: { uri }, title?, startRevisionId, endRevisionId, cellIds?, author? }) — returns the existing review for that pair and cell-ID set',
        'await reviews.submit({ target: { uri }, reviewId, outcome, summary?, author? })',
        'await reviews.linkThread({ target: { uri }, reviewId, commentId })',
        'outcome: good_enough|needs_more_work; legacy comment|approve|request_changes remain readable/accepted. Endpoints and scope stay fixed; submission does not change notebook content or resolve threads. Omit cellIds for the whole document; otherwise supply a nonempty set of IDs present in either endpoint. Noncontiguous sets are supported.',
      ].join('\n'),
    list: async (input: { target: unknown }) => {
      const c = await operationContext(input.target)
      return c.store.listNotebookReviews(c.notebookUri)
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
    create: async (input: {
      target: unknown
      title?: string
      baseReviewId?: string
      startRevisionId?: string
      endRevisionId?: string
      cellIds?: string[]
      author?: Attribution
    }) => {
      const c = await operationContext(input.target, true)
      await c.notebookData.flushPendingPersist?.()
      return c.store.createNotebookReview(c.notebookUri, {
        ...input,
        author: normalizeAttribution(input.author),
      })
    },
    preview: async (input: {
      target: unknown
      startRevisionId: string
      endRevisionId: string
      cellIds?: string[]
    }) => {
      const c = await operationContext(input.target)
      return c.store.previewNotebookReview(c.notebookUri, input)
    },
    submit: async (input: {
      target: unknown
      reviewId: string
      outcome: ReviewOutcome
      summary?: string
      author?: Attribution
    }) => {
      const c = await operationContext(input.target, true)
      return c.store.submitNotebookReview(c.notebookUri, {
        ...input,
        author: normalizeAttribution(input.author),
      })
    },
    linkThread: async (input: {
      target: unknown
      reviewId: string
      commentId: string
    }) => {
      const c = await operationContext(input.target, true)
      return c.store.linkNotebookReviewThread(
        c.notebookUri,
        input.reviewId,
        input.commentId
      )
    },
  }
  const revisions = {
    help: () =>
      'revisions.list({target:{uri}}); revisions.label({target:{uri},revisionId,name,description?,author?}); lastChangedAt is the last notebook change, not the label date.',
    list: async (input: { target: unknown }) => {
      const c = await operationContext(input.target)
      await c.notebookData.flushPendingPersist?.()
      return c.store.listNotebookRevisions(c.notebookUri)
    },
    label: async (input: {
      target: unknown
      revisionId: string
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
    reviews,
    revisions,
    suggestions,
    add: async (input: {
      target: unknown
      content: string
      reviewId?: string
      suggestionId?: string
      cellId?: string
      side?: DiffCommentTarget['side']
      sourceRange?: DiffCommentTarget['sourceRange']
      author?: Attribution
    }) => {
      const c = await operationContext(input.target, true)
      if (!input.content.trim()) throw new Error('Comment content is required')
      if (input.reviewId && input.suggestionId)
        throw new Error('Choose a review or a suggestion target')
      if (
        (input.side || input.sourceRange) &&
        (!input.cellId || (!input.reviewId && !input.suggestionId))
      )
        throw new Error(
          'Diff side/range requires a review or suggestion and cellId'
        )
      let anchor: string
      if (input.suggestionId) {
        const suggestion = (await suggestions.list(input)).find(
          (s) => s.id === input.suggestionId
        )
        if (!suggestion)
          throw new Error('Suggestion not found in target notebook')
        anchor = createSuggestionCommentAnchor(
          input.suggestionId,
          input.cellId
            ? createDiffCommentTarget(
                suggestion.diff.cells,
                input.cellId,
                input.side,
                input.sourceRange
              )
            : undefined
        )
      } else if (input.reviewId) {
        const round = (await reviews.list(input)).find(
          (r) => r.id === input.reviewId
        )
        if (!round) throw new Error('Review not found in target notebook')
        const target = input.cellId
          ? createDiffCommentTarget(
              round.diff.cells,
              input.cellId,
              input.side,
              input.sourceRange
            )
          : undefined
        anchor = createReviewAnchor(
          input.reviewId,
          input.cellId,
          target?.quote,
          target
        )
      } else if (input.cellId) {
        if (
          !c.notebookData
            .getNotebook()
            .cells.some((cell) => cell.refId === input.cellId)
        )
          throw new Error('Cell not found')
        anchor = createCellCommentAnchor(input.cellId)
      } else
        throw new Error(
          'An explicit review, suggestion, or cell target is required'
        )
      return c.store.addOperationLogComment(c.notebookUri, {
        content: input.content,
        anchor,
        author: normalizeAttribution(input.author),
      })
    },
    list: (input: ListNotebookCommentsInput = {}) =>
      listNotebookComments(dependencies, input),
    parseAnchor: (anchor: string) => parseCommentAnchor(anchor),
    resolveAnchor: (args: { anchor: string; source: string }) =>
      resolveCommentAnchor(args),
    reply: async (input: CommentReplyInput) => {
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
        return dependencies
          .resolveLocalNotebooks()!
          .replyToOperationLogComment(
            notebookUri,
            input.commentId,
            input.content,
            { author: normalizeAttribution(input.author) }
          )
      }
      if (input.author !== undefined)
        throw new Error(
          'Native Google Drive comment authors cannot be overridden'
        )
      if (localComments) {
        const operation = await localComments.saveDesiredReply({
          notebookUri,
          remoteUri: remoteUri!,
          commentId: input.commentId,
          content: input.content,
        })
        void localComments.reconcile(remoteUri!)
        return operation
      }
      return driveNotebookStore!.replyToComment(
        remoteUri!,
        input.commentId,
        input.content
      )
    },
    resolve: async (input: CommentMutationInput) => {
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
        return dependencies
          .resolveLocalNotebooks()!
          .setOperationLogCommentResolved(notebookUri, input.commentId, true)
      }
      if (localComments) {
        const operation = await localComments.setThreadIntent(
          {
            notebookUri,
            remoteUri: remoteUri!,
            commentId: input.commentId,
          },
          true
        )
        void localComments.reconcile(remoteUri!)
        return operation
      }
      return driveNotebookStore!.resolveComment(remoteUri!, input.commentId)
    },
    reopen: async (input: CommentMutationInput) => {
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
        return dependencies
          .resolveLocalNotebooks()!
          .setOperationLogCommentResolved(notebookUri, input.commentId, false)
      }
      if (localComments) {
        const operation = await localComments.setThreadIntent(
          {
            notebookUri,
            remoteUri: remoteUri!,
            commentId: input.commentId,
          },
          false
        )
        void localComments.reconcile(remoteUri!)
        return operation
      }
      return driveNotebookStore!.reopenComment(remoteUri!, input.commentId)
    },
    help: () =>
      [
        'await comments.list({ target?, status? })',
        'await comments.add({ target, content, reviewId?, suggestionId?, cellId?, side?: "base" | "head", sourceRange?: { start, end, unit: "utf-16" }, author? })',
        'author: { displayName, kind: human|agent|service-account|unknown }; omitted/blank API author is unknown, never the signed-in human',
        'comments.parseAnchor(anchor)',
        'comments.resolveAnchor({ anchor, source })',
        'await comments.reply({ target?, commentId, content, author? })',
        'await comments.resolve({ target?, commentId })',
        'await comments.reopen({ target?, commentId })',
        'comments.list includes sync.status; .runme mutations append to the operation log, while Drive mutations persist locally and reconcile asynchronously',
      ].join('\n'),
  }
}
