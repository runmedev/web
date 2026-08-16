import Dexie, { type Table } from 'dexie'

import {
  type CommentDraftTarget,
  createCellCommentAnchor,
  createPendingCellTextCommentAnchor,
} from '../lib/notebookComments'
import type { DriveComment, DriveNotebookStore, DriveReply } from './drive'

export type LocalCommentSyncStatus =
  | 'pending'
  | 'syncing'
  | 'uncertain'
  | 'failed'

export type CachedCommentRecord = {
  id: string
  remoteUri: string
  commentId: string
  modifiedTime?: string
  comment: DriveComment
}

export type CommentDraftRecord = {
  notebookUri: string
  remoteUri: string
  target: CommentDraftTarget
  content: string
  updatedAt: string
}

type LocalMutationRecord = {
  id: string
  notebookUri: string
  remoteUri: string
  status: LocalCommentSyncStatus
  createdAt: string
  updatedAt: string
  attemptCount: number
  lastError?: string
}

export type DesiredCommentRecord = LocalMutationRecord & {
  recordType: 'desired-comment'
  desiredPresence: true
  content: string
  target: CommentDraftTarget
  displayAnchor: string
  remoteAnchor?: string
  quotedFileContent?: { mimeType: 'text/plain'; value: string }
  absentObservations: number
  retryAfter?: string
}

export type DesiredReplyRecord = LocalMutationRecord & {
  recordType: 'desired-reply'
  commentId: string
  content: string
  serializedContent: string
  desiredPresence: true
  absentObservations: number
  retryAfter?: string
}

export type ThreadIntentRecord = LocalMutationRecord & {
  recordType: 'thread-intent'
  commentId: string
  desiredResolved: boolean
  baselineModifiedTime?: string
}

export type PendingCommentRecord =
  | DesiredCommentRecord
  | DesiredReplyRecord
  | ThreadIntentRecord

export type SaveDesiredCommentInput = {
  notebookUri: string
  remoteUri: string
  content: string
  target: CommentDraftTarget
}

export type SaveDesiredReplyInput = {
  notebookUri: string
  remoteUri: string
  commentId: string
  content: string
}

export type SetThreadIntentInput = {
  notebookUri: string
  remoteUri: string
  commentId: string
}

const LOCAL_COMMENT_ID_PREFIX = 'local:'
const DRIVE_COMMENT_TIMEOUT_MS = 15_000
const UNCERTAIN_CREATE_BACKOFF_MS = 5_000
const RUNME_REPLY_FOOTER_RE =
  /(?:\n\n)?\[runme:v1;reply=([A-Za-z0-9_-]{8,128})\]\s*$/

export function serializeRunmeReply(content: string, clientReplyId: string) {
  return `${content.trimEnd()}\n\n[runme:v1;reply=${clientReplyId}]`
}

export function parseRunmeReply(content: string): {
  content: string
  clientReplyId: string | null
} {
  const match = RUNME_REPLY_FOOTER_RE.exec(content)
  if (!match) return { content, clientReplyId: null }
  return {
    content: content.slice(0, match.index).trimEnd(),
    clientReplyId: match[1] ?? null,
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                `${label} timed out after ${DRIVE_COMMENT_TIMEOUT_MS} ms.`
              )
            ),
          DRIVE_COMMENT_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

function nowIsoString(): string {
  return new Date().toISOString()
}

function localId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
}

function cacheKey(remoteUri: string, commentId: string): string {
  return `${remoteUri}\u0000${commentId}`
}

function cloneComment(comment: DriveComment): DriveComment {
  return {
    ...comment,
    author: comment.author ? { ...comment.author } : undefined,
    quotedFileContent: comment.quotedFileContent
      ? { ...comment.quotedFileContent }
      : undefined,
    mentionedEmailAddresses: comment.mentionedEmailAddresses
      ? [...comment.mentionedEmailAddresses]
      : undefined,
    replies: comment.replies?.map((reply) => {
      const parsed = parseRunmeReply(reply.content ?? '')
      return {
        ...reply,
        content: parsed.content,
        author: reply.author ? { ...reply.author } : undefined,
      }
    }),
  }
}

function localStatusFields(record: PendingCommentRecord) {
  return {
    runmeSyncStatus: record.status,
    runmeSyncError: record.lastError,
    runmeOperationId: record.id,
  } as const
}

export function materializeLocalComments(
  cached: CachedCommentRecord[],
  desiredComments: DesiredCommentRecord[],
  desiredReplies: DesiredReplyRecord[],
  threadIntents: ThreadIntentRecord[]
): DriveComment[] {
  const comments = cached.map((record) => cloneComment(record.comment))
  const byId = new Map(
    comments.flatMap((comment) => (comment.id ? [[comment.id, comment]] : []))
  )

  for (const desired of desiredComments.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )) {
    comments.push({
      id: `${LOCAL_COMMENT_ID_PREFIX}${desired.id}`,
      createdTime: desired.createdAt,
      modifiedTime: desired.updatedAt,
      resolved: false,
      anchor: desired.displayAnchor,
      author: { displayName: 'You', me: true },
      content: desired.content,
      replies: [],
      ...localStatusFields(desired),
    })
  }

  for (const delivery of desiredReplies.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )) {
    const comment = byId.get(delivery.commentId)
    if (!comment) continue
    const reply: DriveReply = {
      id: `${LOCAL_COMMENT_ID_PREFIX}${delivery.id}`,
      createdTime: delivery.createdAt,
      modifiedTime: delivery.updatedAt,
      author: { displayName: 'You', me: true },
      content: delivery.content,
      ...localStatusFields(delivery),
    }
    comment.replies = [...(comment.replies ?? []), reply]
  }

  for (const intent of threadIntents) {
    const comment = byId.get(intent.commentId)
    if (!comment) continue
    Object.assign(comment, localStatusFields(intent), {
      modifiedTime: intent.updatedAt,
      resolved: intent.desiredResolved,
    })
  }
  return comments
}

function clientCommentIdFromAnchor(anchor?: string): string | null {
  if (!anchor) return null
  try {
    const value = JSON.parse(anchor) as {
      runme?: {
        clientCommentId?: unknown
        clientOperationId?: unknown
      }
    }
    const id = value.runme?.clientCommentId ?? value.runme?.clientOperationId
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

function assertRemoteCommentId(commentId: string): void {
  if (commentId.startsWith(LOCAL_COMMENT_ID_PREFIX)) {
    throw new Error('Wait for the comment to sync before changing its thread.')
  }
}

export class LocalComments extends Dexie {
  cachedComments!: Table<CachedCommentRecord, string>
  desiredComments!: Table<DesiredCommentRecord, string>
  desiredReplies!: Table<DesiredReplyRecord, string>
  threadIntents!: Table<ThreadIntentRecord, string>
  drafts!: Table<CommentDraftRecord, string>

  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly inFlightReconciliations = new Map<string, Promise<void>>()
  private readonly draftWriteTails = new Map<string, Promise<void>>()
  private readonly broadcastChannel: BroadcastChannel | undefined

  constructor(
    private readonly driveStore: DriveNotebookStore,
    databaseName = 'runme-local-comments-v1'
  ) {
    super(databaseName)
    this.version(1).stores({
      cachedComments: '&id, remoteUri, commentId, modifiedTime',
      desiredComments: '&id, remoteUri, notebookUri, status, createdAt',
      desiredReplies:
        '&id, remoteUri, notebookUri, status, createdAt, commentId',
      threadIntents:
        '&id, remoteUri, notebookUri, status, createdAt, commentId',
      drafts: '&notebookUri, remoteUri, updatedAt',
    })
    this.cachedComments = this.table('cachedComments')
    this.desiredComments = this.table('desiredComments')
    this.desiredReplies = this.table('desiredReplies')
    this.threadIntents = this.table('threadIntents')
    this.drafts = this.table('drafts')
    this.broadcastChannel =
      typeof window === 'undefined' || typeof BroadcastChannel === 'undefined'
        ? undefined
        : new BroadcastChannel('runme-local-comments')
    if (this.broadcastChannel) {
      this.broadcastChannel.onmessage = (event: MessageEvent<unknown>) => {
        const remoteUri = (event.data as { remoteUri?: unknown })?.remoteUri
        if (typeof remoteUri === 'string') this.notify(remoteUri, false)
      }
    }
  }

  override close(): void {
    this.broadcastChannel?.close()
    super.close()
  }

  subscribe(remoteUri: string, listener: () => void): () => void {
    let listeners = this.listeners.get(remoteUri)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(remoteUri, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.listeners.get(remoteUri)
      current?.delete(listener)
      if (current?.size === 0) this.listeners.delete(remoteUri)
    }
  }

  async list(remoteUri: string): Promise<DriveComment[]> {
    const [cached, desired, replies, intents] = await Promise.all([
      this.cachedComments.where('remoteUri').equals(remoteUri).toArray(),
      this.desiredComments.where('remoteUri').equals(remoteUri).toArray(),
      this.desiredReplies.where('remoteUri').equals(remoteUri).toArray(),
      this.threadIntents.where('remoteUri').equals(remoteUri).toArray(),
    ])
    return materializeLocalComments(cached, desired, replies, intents)
  }

  async getDraft(notebookUri: string): Promise<CommentDraftRecord | null> {
    return (await this.drafts.get(notebookUri)) ?? null
  }

  async saveDraft(draft: Omit<CommentDraftRecord, 'updatedAt'>): Promise<void> {
    const previous = this.draftWriteTails.get(draft.notebookUri)
    const pending = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await this.drafts.put({ ...draft, updatedAt: nowIsoString() })
        this.notify(draft.remoteUri)
      })
    this.draftWriteTails.set(draft.notebookUri, pending)
    const cleanup = () => {
      if (this.draftWriteTails.get(draft.notebookUri) === pending) {
        this.draftWriteTails.delete(draft.notebookUri)
      }
    }
    void pending.then(cleanup, cleanup)
    await pending
  }

  async deleteDraft(notebookUri: string): Promise<void> {
    await this.draftWriteTails.get(notebookUri)?.catch(() => undefined)
    const draft = await this.drafts.get(notebookUri)
    await this.drafts.delete(notebookUri)
    if (draft) this.notify(draft.remoteUri)
  }

  async saveDesiredComment(
    input: SaveDesiredCommentInput
  ): Promise<DesiredCommentRecord> {
    await this.draftWriteTails.get(input.notebookUri)?.catch(() => undefined)
    const timestamp = nowIsoString()
    const record: DesiredCommentRecord = {
      id: localId(),
      notebookUri: input.notebookUri,
      remoteUri: input.remoteUri,
      recordType: 'desired-comment',
      desiredPresence: true,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      attemptCount: 0,
      absentObservations: 0,
      content: input.content.trim(),
      target: input.target,
      displayAnchor: '',
    }
    record.displayAnchor =
      input.target.type === 'cell'
        ? createCellCommentAnchor(input.target.cellId, record.id)
        : createPendingCellTextCommentAnchor(input.target, record.id)
    await this.transaction(
      'rw',
      this.desiredComments,
      this.drafts,
      async () => {
        await this.desiredComments.put(record)
        await this.drafts.delete(input.notebookUri)
      }
    )
    this.notify(input.remoteUri)
    return record
  }

  async saveDesiredReply(
    input: SaveDesiredReplyInput
  ): Promise<DesiredReplyRecord> {
    assertRemoteCommentId(input.commentId)
    const timestamp = nowIsoString()
    const id = localId()
    const content = input.content.trim()
    const record: DesiredReplyRecord = {
      ...input,
      id,
      recordType: 'desired-reply',
      desiredPresence: true,
      content,
      serializedContent: serializeRunmeReply(content, id),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      attemptCount: 0,
      absentObservations: 0,
    }
    await this.desiredReplies.put(record)
    this.notify(input.remoteUri)
    return record
  }

  async setThreadIntent(
    input: SetThreadIntentInput,
    desiredResolved: boolean
  ): Promise<ThreadIntentRecord> {
    assertRemoteCommentId(input.commentId)
    const timestamp = nowIsoString()
    const cached = await this.cachedComments.get(
      cacheKey(input.remoteUri, input.commentId)
    )
    const record: ThreadIntentRecord = {
      ...input,
      id: cacheKey(input.remoteUri, input.commentId),
      recordType: 'thread-intent',
      desiredResolved,
      baselineModifiedTime: cached?.comment.modifiedTime,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      attemptCount: 0,
    }
    await this.threadIntents.put(record)
    this.notify(input.remoteUri)
    return record
  }

  async prepareDesiredComment(
    id: string,
    remoteAnchor: string,
    quotedFileContent?: DesiredCommentRecord['quotedFileContent']
  ): Promise<void> {
    const record = await this.desiredComments.get(id)
    if (!record) throw new Error(`Desired comment not found: ${id}`)
    await this.desiredComments.update(id, {
      remoteAnchor,
      quotedFileContent,
      status: 'pending',
      updatedAt: nowIsoString(),
      lastError: undefined,
    })
    this.notify(record.remoteUri)
  }

  async markDesiredPreparationFailed(
    id: string,
    error: unknown
  ): Promise<void> {
    const record = await this.desiredComments.get(id)
    if (!record) return
    await this.desiredComments.update(id, {
      status: 'failed',
      updatedAt: nowIsoString(),
      lastError: String(error),
    })
    this.notify(record.remoteUri)
  }

  async listPendingRecords(remoteUri: string): Promise<PendingCommentRecord[]> {
    const records = (
      await Promise.all([
        this.desiredComments.where('remoteUri').equals(remoteUri).toArray(),
        this.desiredReplies.where('remoteUri').equals(remoteUri).toArray(),
        this.threadIntents.where('remoteUri').equals(remoteUri).toArray(),
      ])
    ).flat()
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async retryNeedsAttention(remoteUri: string): Promise<void> {
    const records = await this.listPendingRecords(remoteUri)
    const timestamp = nowIsoString()
    await this.transaction(
      'rw',
      this.desiredComments,
      this.desiredReplies,
      this.threadIntents,
      async () => {
        for (const record of records) {
          if (record.status !== 'failed' && record.status !== 'uncertain') {
            continue
          }
          const patch = {
            status: 'pending' as const,
            updatedAt: timestamp,
            lastError: undefined,
          }
          if (record.recordType === 'desired-comment') {
            await this.desiredComments.update(record.id, {
              ...patch,
              absentObservations: 0,
              retryAfter: undefined,
            })
          } else if (record.recordType === 'desired-reply') {
            await this.desiredReplies.update(record.id, {
              ...patch,
              absentObservations: 0,
              retryAfter: undefined,
            })
          } else {
            await this.threadIntents.update(record.id, patch)
          }
        }
      }
    )
    this.notify(remoteUri)
  }

  async refresh(remoteUri: string): Promise<void> {
    const comments = await withTimeout(
      this.driveStore.listComments(remoteUri),
      'Loading Google Drive comments'
    )
    await this.replaceCachedComments(remoteUri, comments)
  }

  reconcile(remoteUri: string): Promise<void> {
    const current = this.inFlightReconciliations.get(remoteUri)
    if (current) return current
    const run = () => this.reconcileInner(remoteUri)
    const pending = (
      typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(
            `runme-comments:${remoteUri}`,
            { mode: 'exclusive' },
            run
          )
        : run()
    ).finally(() => {
      if (this.inFlightReconciliations.get(remoteUri) === pending) {
        this.inFlightReconciliations.delete(remoteUri)
      }
    })
    this.inFlightReconciliations.set(remoteUri, pending)
    return pending
  }

  private async reconcileInner(remoteUri: string): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return

    // A complete pull is the observation on which every derived mutation is
    // based. No create is sent before proving its client id is absent.
    const remoteComments = await withTimeout(
      this.driveStore.listComments(remoteUri),
      'Reconciling Google Drive comments'
    )
    await this.replaceCachedComments(remoteUri, remoteComments)
    const remoteById = new Map(
      remoteComments.flatMap((comment) =>
        comment.id ? [[comment.id, comment]] : []
      )
    )
    const remoteByClientId = new Map(
      remoteComments.flatMap((comment) => {
        const id = clientCommentIdFromAnchor(comment.anchor)
        return id ? [[id, comment]] : []
      })
    )

    for (const desired of await this.desiredComments
      .where('remoteUri')
      .equals(remoteUri)
      .sortBy('createdAt')) {
      const existing = remoteByClientId.get(desired.id)
      if (existing) {
        await this.desiredComments.delete(desired.id)
        continue
      }
      if (!desired.remoteAnchor || desired.status === 'failed') continue
      if (desired.status === 'uncertain') {
        if (desired.retryAfter && desired.retryAfter > nowIsoString()) continue
        const observations = desired.absentObservations + 1
        if (observations < 2) {
          await this.desiredComments.update(desired.id, {
            absentObservations: observations,
            updatedAt: nowIsoString(),
            retryAfter: new Date(
              Date.now() + UNCERTAIN_CREATE_BACKOFF_MS
            ).toISOString(),
          })
          continue
        }
      }
      await this.publishDesiredComment(desired)
    }

    for (const delivery of await this.desiredReplies
      .where('remoteUri')
      .equals(remoteUri)
      .sortBy('createdAt')) {
      const parent = remoteById.get(delivery.commentId)
      const exists = parent?.replies?.some(
        (reply) =>
          parseRunmeReply(reply.content ?? '').clientReplyId === delivery.id
      )
      if (exists) {
        await this.desiredReplies.delete(delivery.id)
        continue
      }
      if (!parent || delivery.status === 'failed') continue
      if (delivery.status === 'uncertain') {
        if (delivery.retryAfter && delivery.retryAfter > nowIsoString())
          continue
        const observations = delivery.absentObservations + 1
        if (observations < 2) {
          await this.desiredReplies.update(delivery.id, {
            absentObservations: observations,
            updatedAt: nowIsoString(),
            retryAfter: new Date(
              Date.now() + UNCERTAIN_CREATE_BACKOFF_MS
            ).toISOString(),
          })
          continue
        }
      }
      await this.publishReply(delivery)
    }

    for (const intent of await this.threadIntents
      .where('remoteUri')
      .equals(remoteUri)
      .sortBy('createdAt')) {
      const remote = remoteById.get(intent.commentId)
      if (!remote) {
        await this.markThreadIntentFailed(
          intent,
          'The Drive comment no longer exists.'
        )
        continue
      }
      if (Boolean(remote.resolved) === intent.desiredResolved) {
        await this.threadIntents.delete(intent.id)
        continue
      }
      if (
        intent.baselineModifiedTime &&
        remote.modifiedTime &&
        remote.modifiedTime !== intent.baselineModifiedTime
      ) {
        await this.markThreadIntentFailed(
          intent,
          'The Drive thread changed after this local action. Review it before retrying.'
        )
        continue
      }
      if (intent.status === 'pending') await this.publishThreadIntent(intent)
    }
    this.notify(remoteUri)
  }

  private async publishDesiredComment(record: DesiredCommentRecord) {
    await this.desiredComments.update(record.id, {
      status: 'syncing',
      updatedAt: nowIsoString(),
      attemptCount: record.attemptCount + 1,
      lastError: undefined,
    })
    try {
      const comment = await withTimeout(
        this.driveStore.createComment(record.remoteUri, record.content, {
          anchor: record.remoteAnchor,
          quotedFileContent: record.quotedFileContent,
        }),
        'Creating Google Drive comment'
      )
      if (!comment.id)
        throw new Error('Google Drive did not return a comment id.')
      await this.transaction(
        'rw',
        this.cachedComments,
        this.desiredComments,
        async () => {
          await this.cachedComments.put({
            id: cacheKey(record.remoteUri, comment.id as string),
            remoteUri: record.remoteUri,
            commentId: comment.id as string,
            modifiedTime: comment.modifiedTime,
            comment,
          })
          await this.desiredComments.delete(record.id)
        }
      )
    } catch (error) {
      await this.desiredComments.update(record.id, {
        status: 'uncertain',
        updatedAt: nowIsoString(),
        lastError: `Drive may have accepted this comment: ${String(error)}`,
        absentObservations: 0,
        retryAfter: new Date(
          Date.now() + UNCERTAIN_CREATE_BACKOFF_MS
        ).toISOString(),
      })
    }
  }

  private async publishReply(record: DesiredReplyRecord) {
    await this.desiredReplies.update(record.id, {
      status: 'syncing',
      updatedAt: nowIsoString(),
      attemptCount: record.attemptCount + 1,
      lastError: undefined,
    })
    try {
      const reply = await withTimeout(
        this.driveStore.replyToComment(
          record.remoteUri,
          record.commentId,
          record.serializedContent
        ),
        'Creating Google Drive comment reply'
      )
      await this.completeReply(record, reply)
    } catch (error) {
      await this.desiredReplies.update(record.id, {
        status: 'uncertain',
        updatedAt: nowIsoString(),
        lastError: `Drive may have accepted this reply: ${String(error)}`,
        absentObservations: 0,
        retryAfter: new Date(
          Date.now() + UNCERTAIN_CREATE_BACKOFF_MS
        ).toISOString(),
      })
    }
  }

  private async publishThreadIntent(record: ThreadIntentRecord) {
    await this.threadIntents.update(record.id, {
      status: 'syncing',
      updatedAt: nowIsoString(),
      attemptCount: record.attemptCount + 1,
      lastError: undefined,
    })
    try {
      const reply = await withTimeout(
        record.desiredResolved
          ? this.driveStore.resolveComment(record.remoteUri, record.commentId)
          : this.driveStore.reopenComment(record.remoteUri, record.commentId),
        `${record.desiredResolved ? 'Resolving' : 'Reopening'} Google Drive comment`
      )
      await this.completeThreadIntent(record, reply)
    } catch (error) {
      await this.threadIntents.update(record.id, {
        status: 'uncertain',
        updatedAt: nowIsoString(),
        lastError: `Drive may have accepted this action: ${String(error)}`,
      })
    }
  }

  private async completeReply(record: DesiredReplyRecord, reply: DriveReply) {
    const key = cacheKey(record.remoteUri, record.commentId)
    await this.transaction(
      'rw',
      this.cachedComments,
      this.desiredReplies,
      async () => {
        const cached = await this.cachedComments.get(key)
        if (cached) {
          const comment = cloneComment(cached.comment)
          comment.modifiedTime = reply.modifiedTime ?? nowIsoString()
          comment.replies = [...(comment.replies ?? []), reply]
          await this.cachedComments.put({
            ...cached,
            modifiedTime: comment.modifiedTime,
            comment,
          })
        }
        await this.desiredReplies.delete(record.id)
      }
    )
  }

  private async completeThreadIntent(
    record: ThreadIntentRecord,
    reply: DriveReply
  ) {
    const key = cacheKey(record.remoteUri, record.commentId)
    await this.transaction(
      'rw',
      this.cachedComments,
      this.threadIntents,
      async () => {
        const cached = await this.cachedComments.get(key)
        if (cached) {
          const comment = cloneComment(cached.comment)
          comment.modifiedTime = reply.modifiedTime ?? nowIsoString()
          comment.replies = [...(comment.replies ?? []), reply]
          comment.resolved = record.desiredResolved
          await this.cachedComments.put({
            ...cached,
            modifiedTime: comment.modifiedTime,
            comment,
          })
        }
        await this.threadIntents.delete(record.id)
      }
    )
  }

  private async markThreadIntentFailed(
    record: ThreadIntentRecord,
    error: unknown
  ) {
    await this.threadIntents.update(record.id, {
      status: 'failed',
      updatedAt: nowIsoString(),
      lastError: String(error),
    })
  }

  private async replaceCachedComments(
    remoteUri: string,
    comments: DriveComment[]
  ): Promise<void> {
    await this.transaction('rw', this.cachedComments, async () => {
      await this.cachedComments.where('remoteUri').equals(remoteUri).delete()
      await this.cachedComments.bulkPut(
        comments.flatMap((comment) =>
          comment.id
            ? [
                {
                  id: cacheKey(remoteUri, comment.id),
                  remoteUri,
                  commentId: comment.id,
                  modifiedTime: comment.modifiedTime,
                  comment,
                },
              ]
            : []
        )
      )
    })
    this.notify(remoteUri)
  }

  private notify(remoteUri: string, broadcast = true): void {
    for (const listener of this.listeners.get(remoteUri) ?? []) {
      try {
        listener()
      } catch {
        // One consumer must not prevent other open views from updating.
      }
    }
    if (broadcast) this.broadcastChannel?.postMessage({ remoteUri })
  }
}

export default LocalComments
