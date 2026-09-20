import { create } from '@bufbuild/protobuf'
import { beforeEach, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import type { NotebookDocument } from './runtime/runmeConsole'
import { gradeSuggestion } from './suggestionGrader'
import { gradeNotebookUpdate } from './suggestionGraderUpdate'
import { replayContent } from './trainingExamples/payloads'

vi.mock('./suggestionGrader', () => ({ gradeSuggestion: vi.fn() }))

/** Build isolated content snapshots without a storage backend. */
function doc(cells: Array<[string, string]>): NotebookDocument {
  return {
    summary: {
      uri: 'local://test',
      name: 'test.runme',
      isOpen: true,
      source: 'local',
    },
    handle: { uri: 'local://test', revision: JSON.stringify(cells) },
    notebook: create(parser_pb.NotebookSchema, {
      cells: cells.map(([refId, value]) =>
        create(parser_pb.CellSchema, {
          refId,
          value,
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          metadata: { secret: 'excluded' },
        })
      ),
    }),
  }
}
beforeEach(() => {
  vi.mocked(gradeSuggestion).mockReset()
})

it('grades each net insertion/update/deletion with only baseline context', async () => {
  vi.mocked(gradeSuggestion).mockResolvedValue({
    accepted: true,
    model: 'test',
    requestId: null,
  })
  const before = doc([
    ['a', 'old'],
    ['b', 'remove'],
    ['d', 'unchanged'],
  ])
  const after = doc([
    ['a', 'new'],
    ['c', 'insert'],
    ['d', 'unchanged'],
  ])
  const results = await gradeNotebookUpdate(before, after)
  expect(results.map((r) => r.cellId).sort()).toEqual(['a', 'b', 'c'])
  expect(results.every((r) => r.status === 'graded')).toBe(true)
  const proposals = vi
    .mocked(gradeSuggestion)
    .mock.calls.map(([input]) =>
      replayContent(input.initial, input.operations).map((c) => c.cell.value)
    )
  expect(proposals).toContainEqual(['new', 'remove', 'unchanged'])
  expect(proposals).toContainEqual(['old', 'unchanged'])
  expect(JSON.stringify(vi.mocked(gradeSuggestion).mock.calls)).not.toContain(
    'excluded'
  )
})

it('bounds concurrency, retains ordered partial results, and does not retry errors', async () => {
  const finish: Array<() => void> = []
  vi.mocked(gradeSuggestion).mockImplementation(
    () =>
      new Promise((resolve) =>
        finish.push(() =>
          resolve({ accepted: false, model: 'test', requestId: null })
        )
      )
  )
  const result = gradeNotebookUpdate(
    doc([]),
    doc([
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'c'],
    ])
  )
  expect(gradeSuggestion).toHaveBeenCalledTimes(2)
  vi.mocked(gradeSuggestion).mockRejectedValue(new Error('No prediction'))
  finish[0]()
  finish[1]()
  expect(await result).toMatchObject([
    { cellId: 'a', status: 'graded', accepted: false },
    { cellId: 'b', status: 'graded', accepted: false },
    { cellId: 'c', status: 'error', error: 'No prediction' },
  ])
  expect(gradeSuggestion).toHaveBeenCalledTimes(3)
})

it('makes no request for metadata-only changes, no-ops, or cancellation', async () => {
  const before = doc([['a', 'same']]),
    after = doc([['a', 'same']])
  after.notebook.cells[0].metadata = { updated: 'yes' }
  expect(await gradeNotebookUpdate(before, after)).toEqual([])
  const controller = new AbortController()
  controller.abort()
  expect(
    await gradeNotebookUpdate(doc([]), before, controller.signal)
  ).toMatchObject([{ cellId: 'a', status: 'error' }])
  expect(gradeSuggestion).not.toHaveBeenCalled()
})
