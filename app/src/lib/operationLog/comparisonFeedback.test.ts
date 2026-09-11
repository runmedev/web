import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type LocalNotebooks from '../../storage/local'
import {
  assessComparison,
  commentOnComparison,
  decideComparisonCell,
} from './comparisonFeedback'
import { computeReviewDiff } from './reviewScope'

function fixture() {
  const before = create(parser_pb.NotebookSchema)
  const after = create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        refId: 'c',
        kind: parser_pb.CellKind.MARKUP,
        value: 'Hello world',
      }),
    ],
  })
  const methods = {
    previewNotebookComparison: vi.fn(async () => ({
      diff: computeReviewDiff(before, after),
      before,
      after,
      start: { version: { kind: 'revision', revision_id: 'start' } },
      end: { version: { kind: 'revision', revision_id: 'end' } },
      cellIds: ['c'],
    })),
    checkpointNotebookRevision: vi.fn(async () => ({ id: 'stable' })),
    addAnchoredComment: vi.fn(async (_uri, input) => ({
      id: 'thread',
      ...input,
    })),
    decideNotebookComparisonCell: vi.fn(async () => undefined),
    loadContent: vi.fn(async (): Promise<string> => {
      throw new Error('Reload failed')
    }),
  }
  return { methods, store: methods as unknown as LocalNotebooks }
}
const selection = {
  startRevisionId: 'empty',
  endRevisionId: 'v1',
  cellIds: ['c'],
}
describe('direct comparison feedback', () => {
  it('refuses undo during execution without cancelling other cells', async () => {
    const { store, methods } = fixture()
    const notebook = {
      hasActiveExecutions: () => true,
      cancelActiveExecutions: vi.fn(),
    }
    await expect(
      decideComparisonCell(
        store,
        'local://file/test',
        { ...selection, cellId: 'c', decision: 'undo' },
        notebook
      )
    ).rejects.toThrow('running cells')
    expect(notebook.cancelActiveExecutions).not.toHaveBeenCalled()
    expect(methods.checkpointNotebookRevision).not.toHaveBeenCalled()
  })
  it('keeps the neighboring editor locked after a committed undo cannot reload', async () => {
    const { store, methods } = fixture()
    const notebook = {
      setReviewPending: vi.fn(),
      setReviewReloadRequired: vi.fn(),
      setNotebookStore: vi.fn(),
      loadNotebook: vi.fn(),
      flushPendingPersist: vi.fn(async () => undefined),
    }
    await expect(
      decideComparisonCell(
        store,
        'local://file/test',
        { ...selection, cellId: 'c', decision: 'undo' },
        notebook
      )
    ).rejects.toThrow('Reload failed')
    expect(methods.decideNotebookComparisonCell).toHaveBeenCalled()
    expect(notebook.setReviewPending.mock.calls).toEqual([[true]])
    expect(notebook.setReviewReloadRequired).toHaveBeenCalledWith(true)
  })
  it('unlocks the editor when a guarded undo is rejected before commit', async () => {
    const { store, methods } = fixture()
    methods.decideNotebookComparisonCell.mockRejectedValueOnce(
      new Error('Cell changed since revision')
    )
    const notebook = {
      setReviewPending: vi.fn(),
      setReviewReloadRequired: vi.fn(),
      setNotebookStore: vi.fn(),
      loadNotebook: vi.fn(),
      flushPendingPersist: vi.fn(async () => undefined),
    }
    await expect(
      decideComparisonCell(
        store,
        'local://file/test',
        { ...selection, cellId: 'c', decision: 'undo' },
        notebook
      )
    ).rejects.toThrow('Cell changed since')
    expect(notebook.setReviewPending.mock.calls).toEqual([[true], [false]])
    expect(notebook.setReviewReloadRequired).not.toHaveBeenCalled()
    expect(methods.loadContent).not.toHaveBeenCalled()
  })
  it('creates a frozen scoped comment without a setup step and derives its quote', async () => {
    const { store, methods } = fixture()
    const comment = await commentOnComparison(store, 'local://file/test', {
      ...selection,
      content: 'Explain',
      cellId: 'c',
      side: 'head',
      sourceRange: { start: 6, end: 11, unit: 'utf-16' },
    })
    expect(comment).toMatchObject({
      anchors: [
        {
          kind: 'cell',
          cell_id: 'c',
          version: { kind: 'revision', revision_id: 'end' },
          selection_surface: 'source',
          range: { start_index: 6, end_index: 11, unit: 'unicode-code-point' },
        },
      ],
      comparison: { cell_ids: ['c'] },
    })
    expect(methods.checkpointNotebookRevision).not.toHaveBeenCalled()
  })
  it('rejects invalid comments or targets before creating a record', async () => {
    const { store, methods } = fixture()
    for (const patch of [
      { content: ' ' },
      { cellId: 'missing' },
      { side: 'head' as const },
      {
        cellId: 'c',
        sourceRange: { start: 6, end: 100, unit: 'utf-16' as const },
      },
    ]) {
      await expect(
        commentOnComparison(store, 'local://file/test', {
          ...selection,
          content: 'test',
          ...patch,
        })
      ).rejects.toThrow()
    }
    expect(methods.checkpointNotebookRevision).not.toHaveBeenCalled()
    expect(methods.addAnchoredComment).not.toHaveBeenCalled()
  })
  it('records only an assessment using the same canonical selection', async () => {
    const { store, methods } = fixture()
    await assessComparison(store, 'local://file/test', {
      ...selection,
      outcome: 'good_enough',
    })
    expect(methods.addAnchoredComment).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining({
        assessment: { kind: 'scope', outcome: 'good_enough' },
        comparison: {
          start: { kind: 'revision', revision_id: 'start' },
          end: { kind: 'revision', revision_id: 'end' },
          cell_ids: ['c'],
        },
      })
    )
  })
})
