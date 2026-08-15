import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type { DriveNotebookStore } from '../../storage/drive'
import { listNotebookCommentsForAgents } from './notebookCommentsTool'
import type { NotebookDataLike } from './runmeConsole'

describe('listNotebookCommentsForAgents', () => {
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
      getNotebook: () => notebook,
    } as unknown as NotebookDataLike

    const result = await listNotebookCommentsForAgents({
      input: {},
      currentUri: 'https://drive.google.com/file/d/file123/view',
      resolveNotebook: () => notebookData,
      localNotebooks: null,
      driveNotebookStore,
    })

    expect(listComments).toHaveBeenCalledWith(
      'https://drive.google.com/file/d/file123/view'
    )
    expect(result).toEqual([
      expect.objectContaining({
        id: 'comment-1',
        content: 'Clarify this.',
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
})
