// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { createCellCommentAnchor } from '../lib/notebookComments'
import type { DriveComment, DriveNotebookStore } from './drive'
import LocalComments, {
  type CachedCommentRecord,
  type CommentDraftRecord,
  type DesiredCommentRecord,
  type DesiredReplyRecord,
  type ThreadIntentRecord,
  materializeLocalComments,
  parseRunmeReply,
  serializeRunmeReply,
} from './localComments'

type Row = { id?: string; notebookUri?: string }

function createMockTable<T extends Row>(primaryKey: keyof T) {
  const rows = new Map<string, T>()
  const keyFor = (row: T) => String(row[primaryKey])
  const collection = (values: () => T[]) => ({
    toArray: vi.fn(async () => values()),
    sortBy: vi.fn(async (field: keyof T) =>
      values().sort((a, b) =>
        String(a[field] ?? '').localeCompare(String(b[field] ?? ''))
      )
    ),
    filter: vi.fn((predicate: (row: T) => boolean) =>
      collection(() => values().filter(predicate))
    ),
    delete: vi.fn(async () => {
      for (const row of values()) {
        rows.delete(keyFor(row))
      }
    }),
  })
  return {
    rows,
    get: vi.fn(async (key: string) => rows.get(key)),
    put: vi.fn(async (row: T) => {
      rows.set(keyFor(row), row)
      return keyFor(row)
    }),
    bulkPut: vi.fn(async (next: T[]) => {
      next.forEach((row) => rows.set(keyFor(row), row))
    }),
    update: vi.fn(async (key: string, patch: Partial<T>) => {
      const current = rows.get(key)
      if (!current) {
        return 0
      }
      rows.set(key, { ...current, ...patch })
      return 1
    }),
    delete: vi.fn(async (key: string) => rows.delete(key)),
    where: vi.fn((field: keyof T) => ({
      equals: vi.fn((value: unknown) =>
        collection(() =>
          [...rows.values()].filter((row) => row[field] === value)
        )
      ),
    })),
  }
}

function createTestStore(driveStore: Partial<DriveNotebookStore>) {
  const store = new LocalComments(
    driveStore as DriveNotebookStore,
    `local-comments-${Math.random()}`
  )
  const cached = createMockTable<CachedCommentRecord>('id')
  const desiredComments = createMockTable<DesiredCommentRecord>('id')
  const desiredReplies = createMockTable<DesiredReplyRecord>('id')
  const threadIntents = createMockTable<ThreadIntentRecord>('id')
  const drafts = createMockTable<CommentDraftRecord>('notebookUri')
  Object.assign(store, {
    cachedComments: cached,
    desiredComments,
    desiredReplies,
    threadIntents,
    drafts,
    transaction: vi.fn(async (...args: unknown[]) => {
      const callback = args.at(-1) as () => Promise<unknown>
      return callback()
    }),
  })
  return {
    store,
    cached,
    desiredComments,
    desiredReplies,
    threadIntents,
    drafts,
  }
}

describe('LocalComments', () => {
  it('round-trips only a valid terminal visible Runme footer', () => {
    const serialized = serializeRunmeReply(
      'Please update the example.',
      'reply-client-123'
    )
    expect(serialized).toBe(
      'Please update the example.\n\n[runme:v1;reply=reply-client-123]'
    )
    expect(parseRunmeReply(serialized)).toEqual({
      content: 'Please update the example.',
      clientReplyId: 'reply-client-123',
    })
    expect(
      parseRunmeReply('[runme:v1;reply=reply-client-123]\nnot terminal')
    ).toEqual({
      content: '[runme:v1;reply=reply-client-123]\nnot terminal',
      clientReplyId: null,
    })
  })

  it('materializes pending creates, replies, and thread state', () => {
    const cached: CachedCommentRecord[] = [
      {
        id: 'remote\u0000comment-1',
        remoteUri: 'remote',
        commentId: 'comment-1',
        comment: {
          id: 'comment-1',
          content: 'Remote comment',
          resolved: false,
          replies: [],
        },
      },
    ]
    const base = {
      notebookUri: 'local',
      remoteUri: 'remote',
      status: 'pending' as const,
      updatedAt: '2026-08-16T10:00:00Z',
      attemptCount: 0,
    }
    const desiredComments: DesiredCommentRecord[] = [
      {
        ...base,
        id: 'create-1',
        recordType: 'desired-comment',
        desiredPresence: true,
        createdAt: '2026-08-16T10:00:00Z',
        content: 'Local comment',
        target: { type: 'cell', cellId: 'cell-1' },
        displayAnchor: createCellCommentAnchor('cell-1', 'create-1'),
        absentObservations: 0,
      },
    ]
    const replies: DesiredReplyRecord[] = [
      {
        ...base,
        id: 'reply-1',
        recordType: 'desired-reply',
        createdAt: '2026-08-16T10:01:00Z',
        commentId: 'comment-1',
        content: 'Local reply',
        serializedContent: 'Local reply\n\n[runme:v1;reply=reply-1]',
        desiredPresence: true,
        absentObservations: 0,
      },
    ]
    const intents: ThreadIntentRecord[] = [
      {
        ...base,
        id: 'resolve-1',
        recordType: 'thread-intent',
        createdAt: '2026-08-16T10:02:00Z',
        commentId: 'comment-1',
        desiredResolved: true,
      },
    ]

    const comments = materializeLocalComments(
      cached,
      desiredComments,
      replies,
      intents
    )

    expect(comments).toHaveLength(2)
    expect(comments[0]).toMatchObject({
      id: 'comment-1',
      resolved: true,
      runmeSyncStatus: 'pending',
    })
    expect(comments[0]?.replies?.[0]).toMatchObject({
      content: 'Local reply',
      runmeSyncStatus: 'pending',
    })
    expect(comments[1]).toMatchObject({
      id: 'local:create-1',
      content: 'Local comment',
      runmeSyncStatus: 'pending',
    })
  })

  it('atomically replaces a saved draft with a queued create', async () => {
    const { store, drafts, desiredComments } = createTestStore({})
    await store.saveDraft({
      notebookUri: 'local',
      remoteUri: 'remote',
      target: { type: 'cell', cellId: 'cell-1' },
      content: 'Draft text',
    })

    const desired = await store.saveDesiredComment({
      notebookUri: 'local',
      remoteUri: 'remote',
      target: { type: 'cell', cellId: 'cell-1' },
      content: 'Draft text',
    })

    expect(drafts.rows.size).toBe(0)
    expect(desiredComments.rows.get(desired.id)).toMatchObject({
      recordType: 'desired-comment',
      status: 'pending',
      content: 'Draft text',
    })
    expect(desired.displayAnchor).toContain(desired.id)
  })

  it('deduplicates an ambiguous top-level create by client operation id', async () => {
    let existing: DriveComment[] = []
    let remoteAnchor = ''
    const createComment = vi.fn(async () => {
      existing = [
        {
          id: 'drive-comment-1',
          content: 'Saved once',
          anchor: remoteAnchor,
        },
      ]
      throw new Error('response lost')
    })
    const listComments = vi.fn(async () => existing)
    const { store, desiredComments } = createTestStore({
      createComment,
      listComments,
    })
    const pending = await store.saveDesiredComment({
      notebookUri: 'local',
      remoteUri: 'remote',
      target: { type: 'cell', cellId: 'cell-1' },
      content: 'Saved once',
    })
    remoteAnchor = createCellCommentAnchor('cell-1', pending.id)
    await store.prepareDesiredComment(pending.id, remoteAnchor)

    await store.reconcile('remote')
    expect(desiredComments.rows.get(pending.id)).toMatchObject({
      status: 'uncertain',
    })
    await store.reconcile('remote')

    expect(createComment).toHaveBeenCalledTimes(1)
    expect(desiredComments.rows.size).toBe(0)
    expect(await store.list('remote')).toEqual([
      expect.objectContaining({ id: 'drive-comment-1', content: 'Saved once' }),
    ])
  })

  it('does not automatically retry an ambiguous reply', async () => {
    const remoteComment: DriveComment = {
      id: 'comment-1',
      content: 'Remote',
      replies: [],
    }
    const replyToComment = vi.fn(async () => {
      throw new Error('response lost')
    })
    const { store } = createTestStore({
      listComments: vi.fn(async () => [remoteComment]),
      replyToComment,
    })
    await store.refresh('remote')
    await store.saveDesiredReply({
      notebookUri: 'local',
      remoteUri: 'remote',
      commentId: 'comment-1',
      content: 'Possibly delivered',
    })

    await store.reconcile('remote')
    await store.reconcile('remote')

    expect(replyToComment).toHaveBeenCalledTimes(1)
    expect((await store.listPendingRecords('remote'))[0]).toMatchObject({
      status: 'uncertain',
      lastError: expect.stringContaining('response lost'),
    })
  })

  it('acknowledges an ambiguously delivered reply by its visible footer', async () => {
    const remoteComment: DriveComment = {
      id: 'comment-1',
      content: 'Remote',
      replies: [],
    }
    const replyToComment = vi.fn(async (_uri, _commentId, content) => {
      remoteComment.replies = [
        { id: 'drive-reply-1', content: content as string },
      ]
      throw new Error('response lost')
    })
    const { store, desiredReplies } = createTestStore({
      listComments: vi.fn(async () => [remoteComment]),
      replyToComment,
    })
    await store.saveDesiredReply({
      notebookUri: 'local',
      remoteUri: 'remote',
      commentId: 'comment-1',
      content: 'Delivered once',
    })

    await store.reconcile('remote')
    expect(desiredReplies.rows.size).toBe(1)
    await store.reconcile('remote')

    expect(replyToComment).toHaveBeenCalledTimes(1)
    expect(desiredReplies.rows.size).toBe(0)
    expect((await store.list('remote'))[0]?.replies?.[0]?.content).toBe(
      'Delivered once'
    )
  })
})
