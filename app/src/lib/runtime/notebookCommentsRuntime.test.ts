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
  it('exposes direct comparison feedback with attribution and editor flushing', async () => {
    const flushPendingPersist = vi.fn(async () => undefined)
    const localNotebooks = {
      isOperationLogNotebook: vi.fn(async () => true),
      previewNotebookReview: vi.fn(async () => ({ diff: { cells: [] } })),
      createNotebookReview: vi.fn(async () => ({ id: 'comparison' })),
      addOperationLogComment: vi.fn(async (_uri, input) => ({
        id: 'thread',
        ...input,
      })),
      submitNotebookReview: vi.fn(async () => undefined),
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
    const comment = await api.reviews.comment({
      ...input,
      content: 'Suggestion feedback',
      author: { displayName: 'Codex', kind: 'agent' },
    })
    expect(comment.author).toMatchObject({
      displayName: 'Codex',
      kind: 'agent',
    })
    expect(JSON.parse(comment.anchor!).runme.reviewId).toBe('comparison')
    expect(
      await api.reviews.assess({ ...input, outcome: 'good_enough' })
    ).toEqual({ comparisonId: 'comparison', outcome: 'good_enough' })
    expect(flushPendingPersist).toHaveBeenCalledTimes(2)
    expect(localNotebooks.submitNotebookReview).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining({
        author: { displayName: 'unknown', kind: 'unknown' },
      })
    )
    expect(api.reviews.help()).toContain('reviews.comment')
    expect(api.reviews.help()).toContain('reviews.assess')
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
        api.reviews.comment({
          ...input,
          startRevisionId: 'empty',
          endRevisionId: 'v1',
          content: 'test',
        })
      ).rejects.toThrow('read-only or busy')
      await expect(
        api.reviews.assess({
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
      expect(api.reviews.help()).toContain('reviews.linkThread')
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

    expect(await comments.list()).toEqual([
      expect.objectContaining({ id: 'comment-1', content: 'Clarify this.' }),
    ])
    await comments.reply({ commentId: 'comment-1', content: 'Done.' })
    await comments.resolve({ commentId: 'comment-1' })
    await comments.reopen({ commentId: 'comment-1' })

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
