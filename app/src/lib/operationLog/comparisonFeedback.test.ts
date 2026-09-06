import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type LocalNotebooks from '../../storage/local'
import { assessComparison, commentOnComparison } from './comparisonFeedback'
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
    previewNotebookReview: vi.fn(async () => ({
      diff: computeReviewDiff(before, after),
    })),
    createNotebookReview: vi.fn(async () => ({ id: 'stable' })),
    addOperationLogComment: vi.fn(async (_uri, input) => ({
      id: 'thread',
      ...input,
    })),
    submitNotebookReview: vi.fn(async () => undefined),
  }
  return { methods, store: methods as unknown as LocalNotebooks }
}
const selection = {
  startRevisionId: 'empty',
  endRevisionId: 'v1',
  cellIds: ['c'],
}
describe('direct comparison feedback', () => {
  it('creates a frozen scoped comment without a setup step and derives its quote', async () => {
    const { store, methods } = fixture()
    const comment = await commentOnComparison(store, 'local://file/test', {
      ...selection,
      content: 'Explain',
      cellId: 'c',
      side: 'head',
      sourceRange: { start: 6, end: 11, unit: 'utf-16' },
    })
    expect(JSON.parse(comment.anchor!).runme).toMatchObject({
      reviewId: 'stable',
      cellId: 'c',
      quote: 'world',
      diffTarget: {
        side: 'head',
        sourceRange: { start: 6, end: 11, unit: 'utf-16' },
      },
    })
    expect(methods.createNotebookReview).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining(selection)
    )
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
    expect(methods.createNotebookReview).not.toHaveBeenCalled()
    expect(methods.addOperationLogComment).not.toHaveBeenCalled()
  })
  it('records only an assessment using the same canonical selection', async () => {
    const { store, methods } = fixture()
    expect(
      await assessComparison(store, 'local://file/test', {
        ...selection,
        outcome: 'good_enough',
      })
    ).toEqual({ comparisonId: 'stable', outcome: 'good_enough' })
    expect(methods.submitNotebookReview).toHaveBeenCalledWith(
      'local://file/test',
      { reviewId: 'stable', outcome: 'good_enough', author: undefined }
    )
    expect(methods.addOperationLogComment).not.toHaveBeenCalled()
  })
})
