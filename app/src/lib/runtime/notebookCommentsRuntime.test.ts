import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type { DriveNotebookStore } from '../../storage/drive'
import {
  createNotebookCommentsRuntimeApi,
  listNotebookComments,
} from './notebookCommentsRuntime'
import type { NotebookDataLike } from './runmeConsole'

describe('notebook comments runtime', () => {
  it('creates a revision through the public API and preserves the selected snapshot', async () => {
    const uri = 'local://file/create-revision'
    const target = { uri }
    const version = { kind: 'revision' as const, revision_id: 'revision:1' }
    const flushPendingPersist = vi.fn(async () => undefined)
    const checkpointNotebookRevision = vi.fn(async () => version)
    const api = createNotebookCommentsRuntimeApi({
      resolveNotebook: () =>
        ({ getUri: () => uri, flushPendingPersist }) as NotebookDataLike,
      resolveLocalNotebooks: () =>
        ({
          isOperationLogNotebook: async () => true,
          checkpointNotebookRevision,
        }) as never,
      resolveDriveNotebookStore: () => null,
    })
    const input = {
      target,
      snapshot_heads: ['actor:1', 'other:2'],
      name: 'Reviewed baseline',
      description: 'Before the next edit',
      author: { displayName: 'Codex', kind: 'agent' as const },
    }
    expect(await api.revisions.create(input)).toEqual(version)
    expect(checkpointNotebookRevision).toHaveBeenCalledWith(uri, input)
    expect(flushPendingPersist.mock.invocationCallOrder[0]).toBeLessThan(
      checkpointNotebookRevision.mock.invocationCallOrder[0]
    )
    await api.revisions.create({ target })
    expect(checkpointNotebookRevision).toHaveBeenLastCalledWith(uri, {
      target,
      author: { displayName: 'unknown', kind: 'unknown' },
    })
    expect(api.revisions).not.toHaveProperty('checkpoint')
    expect(api.revisions.help()).toContain('revisions.create(')
  })

  it('accepts the documented version and comment reference fields', async () => {
    const store = {
      isOperationLogNotebook: vi.fn(async () => true),
      previewNotebookComparison: vi.fn(async () => ({})),
      labelNotebookRevision: vi.fn(async () => ({})),
      listNotebookRevisions: vi.fn(async () => []),
      replyToOperationLogComment: vi.fn(async () => ({})),
      setOperationLogCommentResolved: vi.fn(async () => ({})),
    }
    const uri = 'local://file/canonical'
    const target = { uri }
    const api = createNotebookCommentsRuntimeApi({
      resolveNotebook: () => ({ getUri: () => uri }) as NotebookDataLike,
      resolveLocalNotebooks: () => store as never,
      resolveDriveNotebookStore: () => null,
    })
    const start = { kind: 'revision' as const, revision_id: 'r:1' }
    const end = { kind: 'operation' as const, op_id: 'a:2' }
    await api.comparisons.preview({ target, start, end, cell_ids: ['cell'] })
    expect(store.previewNotebookComparison).toHaveBeenCalledWith(uri, {
      target,
      start,
      end,
      cell_ids: ['cell'],
    })
    await api.revisions.label({ target, revision: end, name: 'Response' })
    expect(store.labelNotebookRevision).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({ revision: end, name: 'Response' })
    )
    await api.reply({ target, parent_comment_id: 'c:1', content: 'Reply' })
    expect(store.replyToOperationLogComment).toHaveBeenCalledWith(
      uri,
      'c:1',
      'Reply',
      expect.any(Object)
    )
    const anchors = [
      {
        kind: 'cell' as const,
        cell_id: 'cell',
        surface: 'source' as const,
        version: end,
      },
    ]
    await api.reply({
      target,
      parent_comment_id: 'c:1',
      content: 'More context',
      anchors,
    })
    expect(store.replyToOperationLogComment).toHaveBeenLastCalledWith(
      uri,
      'c:1',
      'More context',
      expect.objectContaining({ anchors })
    )
    await api.revisions.list({ target })
    expect(store.listNotebookRevisions).toHaveBeenCalledWith(uri)
    await api.resolve({ target, thread_id: 'c:1' })
    expect(store.setOperationLogCommentResolved).toHaveBeenLastCalledWith(
      uri,
      'c:1',
      true
    )
    await api.reopen({ target, thread_id: 'c:1' })
    expect(store.setOperationLogCommentResolved).toHaveBeenLastCalledWith(
      uri,
      'c:1',
      false
    )
  })
  it('exposes direct comparison feedback with attribution and editor flushing', async () => {
    const flushPendingPersist = vi.fn(async () => undefined)
    const localNotebooks = {
      isOperationLogNotebook: vi.fn(async () => true),
      previewNotebookComparison: vi.fn(async () => ({
        diff: { cells: [] },
        before: { cells: [] },
        after: { cells: [] },
        start: { version: { kind: 'revision', revision_id: 'start' } },
        end: { version: { kind: 'revision', revision_id: 'end' } },
      })),
      addAnchoredComment: vi.fn(async (_uri, input) => ({
        id: 'thread',
        ...input,
      })),
      decideNotebookComparisonCell: vi.fn(async () => undefined),
    }
    const api = createNotebookCommentsRuntimeApi({
      resolveNotebook: () =>
        ({
          getUri: () => 'local://file/test',
          flushPendingPersist,
        }) as unknown as NotebookDataLike,
      resolveLocalNotebooks: () => localNotebooks as never,
      resolveDriveNotebookStore: () => null,
    })
    const input = {
      target: { uri: 'local://file/test' },
      startRevisionId: 'empty',
      endRevisionId: 'v1',
    }
    const comment = await api.comparisons.comment({
      ...input,
      content: 'Suggestion feedback',
      author: { displayName: 'Codex', kind: 'agent' },
    })
    expect(comment.author).toMatchObject({
      displayName: 'Codex',
      kind: 'agent',
    })
    expect(comment).toMatchObject({
      comparison: {
        start: { kind: 'revision', revision_id: 'start' },
        end: { kind: 'revision', revision_id: 'end' },
      },
    })
    await api.comparisons.assess({ ...input, outcome: 'good_enough' })
    expect(flushPendingPersist).toHaveBeenCalledTimes(2)
    expect(localNotebooks.addAnchoredComment).toHaveBeenLastCalledWith(
      'local://file/test',
      expect.objectContaining({
        assessment: { kind: 'scope', outcome: 'good_enough' },
        author: { displayName: 'unknown', kind: 'unknown' },
      })
    )
    expect(api).not.toHaveProperty('reviews')
    expect(api.comparisons.help()).toContain('comparisons.comment')
    expect(api.comparisons.help()).toContain('comparisons.assess')
    localNotebooks.previewNotebookComparison.mockResolvedValueOnce({
      diff: { cells: [{ kind: 'modified', compareCell: { refId: 'one' } }] },
    } as never)
    expect(
      await api.comparisons.decideCell({
        ...input,
        cellId: 'one',
        decision: 'accept',
      })
    ).toMatchObject({ cellId: 'one', decision: 'accept' })
    expect(localNotebooks.decideNotebookComparisonCell).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining({
        author: { displayName: 'unknown', kind: 'unknown' },
      })
    )
    expect(api.comparisons.help()).toContain('comparisons.decideCell')
  })
  it.each(['readonly', 'release-pending'])(
    'blocks all discussion mutations when %s',
    async (state) => {
      const localNotebooks = {
        isOperationLogNotebook: vi.fn(async () => true),
        replyToOperationLogComment: vi.fn(),
        setOperationLogCommentResolved: vi.fn(),
      }
      const api = createNotebookCommentsRuntimeApi({
        resolveNotebook: () =>
          ({
            getUri: () => 'local://file/locked',
            isReadOnly: () => state === 'readonly',
            isReleasePending: () => state === 'release-pending',
          }) as NotebookDataLike,
        resolveLocalNotebooks: () => localNotebooks as never,
        resolveDriveNotebookStore: () => null,
      })
      const input = {
        target: { uri: 'local://file/locked' },
        commentId: 'thread',
      }
      await expect(api.reply({ ...input, content: 'Reply' })).rejects.toThrow(
        'read-only or busy'
      )
      await expect(api.resolve(input)).rejects.toThrow('read-only or busy')
      await expect(api.reopen(input)).rejects.toThrow('read-only or busy')
      await expect(
        api.comparisons.decideCell({
          ...input,
          startRevisionId: 'empty',
          endRevisionId: 'v1',
          cellId: 'one',
          decision: 'undo',
        })
      ).rejects.toThrow('read-only or busy')
      await expect(
        api.comparisons.comment({
          ...input,
          startRevisionId: 'empty',
          endRevisionId: 'v1',
          content: 'test',
        })
      ).rejects.toThrow('read-only or busy')
      await expect(
        api.comparisons.assess({
          ...input,
          startRevisionId: 'empty',
          endRevisionId: 'v1',
          outcome: 'good_enough',
        })
      ).rejects.toThrow('read-only or busy')
      await expect(
        api.add({ ...input, cellId: 'one', content: 'New' })
      ).rejects.toThrow('read-only or busy')
      expect(localNotebooks.replyToOperationLogComment).not.toHaveBeenCalled()
      expect(
        localNotebooks.setOperationLogCommentResolved
      ).not.toHaveBeenCalled()
      expect(api.comparisons).not.toHaveProperty('linkThread')
    }
  )
  it('returns the reviewed target and editable source for agents', async () => {
    const anchor = JSON.stringify({
      runme: {
        version: 2,
        type: 'cell-text',
        cellId: 'cell-1',
        surface: 'rendered-markdown',
        state: {
          driveRevisionId: 'revision-7',
          sourceSha256: 'source-hash',
          projection: {
            name: 'runme-markdown-text',
            version: 1,
            sha256: 'projection-hash',
          },
        },
        selectors: [
          { type: 'TextPositionSelector', start: 5, end: 24 },
          { type: 'TextQuoteSelector', exact: 'the migration guide' },
        ],
        sourceHints: [
          { start: 7, end: 11 },
          { start: 12, end: 27 },
        ],
      },
    })
    const listComments = vi.fn(async () => [
      {
        id: 'comment-1',
        content: 'Clarify this.',
        anchor,
        resolved: false,
        replies: [],
      },
    ])
    const driveNotebookStore = {
      listComments,
    } as unknown as DriveNotebookStore
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'cell-1',
          kind: parser_pb.CellKind.MARKUP,
          value: 'Read **the [migration guide](https://example.com)** today.',
        }),
      ],
    })
    const notebookData = {
      getUri: () => 'https://drive.google.com/file/d/file123/view',
      getNotebook: () => notebook,
    } as unknown as NotebookDataLike

    const result = await listNotebookComments(
      {
        resolveNotebook: () => notebookData,
        resolveLocalNotebooks: () => null,
        resolveDriveNotebookStore: () => driveNotebookStore,
      },
      {}
    )

    expect(listComments).toHaveBeenCalledWith(
      'https://drive.google.com/file/d/file123/view'
    )
    expect(result).toEqual([
      expect.objectContaining({
        id: 'comment-1',
        content: 'Clarify this.',
        anchor: expect.objectContaining({
          type: 'cell-text',
          cellId: 'cell-1',
        }),
        originalTarget: expect.objectContaining({
          cellId: 'cell-1',
          surface: 'rendered-markdown',
          revision: 'revision-7',
          reviewedContent: 'the migration guide',
        }),
        editableSource: {
          cellId: 'cell-1',
          content: 'Read **the [migration guide](https://example.com)** today.',
          ranges: [
            { start: 7, end: 11 },
            { start: 12, end: 27 },
          ],
          confidence: 'derived',
        },
        currentResolution: { status: 'exact', start: 5, end: 24 },
      }),
    ])
  })

  it('exposes Drive comment lifecycle operations through one runtime API', async () => {
    const replyToComment = vi.fn(async () => ({ id: 'reply-1' }))
    const resolveComment = vi.fn(async () => ({ action: 'resolve' }))
    const reopenComment = vi.fn(async () => ({ action: 'reopen' }))
    const driveNotebookStore = {
      replyToComment,
      resolveComment,
      reopenComment,
    } as unknown as DriveNotebookStore
    const notebookData = {
      getUri: () => 'https://drive.google.com/file/d/file123/view',
    } as unknown as NotebookDataLike
    const comments = createNotebookCommentsRuntimeApi({
      resolveNotebook: () => notebookData,
      resolveLocalNotebooks: () => null,
      resolveDriveNotebookStore: () => driveNotebookStore,
    })

    await comments.reply({ commentId: 'comment-1', content: 'Done.' })
    await comments.resolve({ commentId: 'comment-1' })
    await comments.reopen({ commentId: 'comment-1' })

    const uri = 'https://drive.google.com/file/d/file123/view'
    expect(replyToComment).toHaveBeenCalledWith(uri, 'comment-1', 'Done.')
    expect(resolveComment).toHaveBeenCalledWith(uri, 'comment-1')
    expect(reopenComment).toHaveBeenCalledWith(uri, 'comment-1')
  })

  it('uses the local operation log for runme comment lifecycle operations', async () => {
    const uri = 'local://file/comments-runme'
    const anchor = JSON.stringify({
      runme: { version: 2, type: 'cell', cellId: 'cell-1' },
    })
    const listOperationLogComments = vi.fn(async () => [
      {
        id: 'comment-1',
        content: 'Clarify this.',
        anchor,
        resolved: false,
        replies: [],
      },
    ])
    const localNotebooks = {
      isOperationLogNotebook: vi.fn(async () => true),
      listOperationLogComments,
      replyToOperationLogComment: vi.fn(async () => ({ id: 'comment-1' })),
      setOperationLogCommentResolved: vi.fn(async () => ({
        id: 'comment-1',
      })),
    }
    const notebookData = {
      getUri: () => uri,
      getNotebook: () =>
        create(parser_pb.NotebookSchema, {
          cells: [
            create(parser_pb.CellSchema, {
              refId: 'cell-1',
              kind: parser_pb.CellKind.MARKUP,
              value: 'Text',
            }),
          ],
        }),
    } as unknown as NotebookDataLike
    const comments = createNotebookCommentsRuntimeApi({
      resolveNotebook: () => notebookData,
      resolveLocalNotebooks: () => localNotebooks as never,
      resolveDriveNotebookStore: () => null,
    })

    await expect(comments.list()).rejects.toThrow('explicit notebook target')
    await expect(
      comments.reply({ commentId: 'comment-1', content: 'No target' })
    ).rejects.toThrow('explicit notebook target')
    await expect(comments.resolve({ commentId: 'comment-1' })).rejects.toThrow(
      'explicit notebook target'
    )
    await expect(comments.reopen({ commentId: 'comment-1' })).rejects.toThrow(
      'explicit notebook target'
    )
    expect(await comments.list({ target: { uri } })).toEqual([
      expect.objectContaining({ id: 'comment-1', content: 'Clarify this.' }),
    ])
    await comments.reply({
      target: { uri },
      commentId: 'comment-1',
      content: 'Done.',
    })
    await comments.resolve({ target: { uri }, commentId: 'comment-1' })
    await comments.reopen({ target: { uri }, commentId: 'comment-1' })

    expect(listOperationLogComments).toHaveBeenCalledWith(uri)
    expect(localNotebooks.replyToOperationLogComment).toHaveBeenCalledWith(
      uri,
      'comment-1',
      'Done.',
      { author: { displayName: 'unknown', kind: 'unknown' } }
    )
    expect(
      localNotebooks.setOperationLogCommentResolved
    ).toHaveBeenNthCalledWith(1, uri, 'comment-1', true)
    expect(
      localNotebooks.setOperationLogCommentResolved
    ).toHaveBeenNthCalledWith(2, uri, 'comment-1', false)
  })
})
