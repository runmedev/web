// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parser_pb } from '../../runme/client'
import { computeNotebookDiff } from '../../lib/notebookDiff/diff'
import { gradeSuggestion, saveGraderSettings } from '../../lib/suggestionGrader'
import type { ReviewPreview } from './ReviewRevisionPicker'
import {
  predictionButtonClass,
  useSuggestionPredictions,
} from './useSuggestionPredictions'

vi.mock('../../lib/suggestionGrader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/suggestionGrader')>()),
  gradeSuggestion: vi.fn(),
}))
function preview(value: string, count = 1) {
  const nb = (text: string) =>
    create(parser_pb.NotebookSchema, {
      cells: Array.from({ length: count }, (_, i) =>
        create(parser_pb.CellSchema, {
          refId: `c${i}`,
          value: text + i,
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
        })
      ),
    })
  const before = nb('old'),
    after = nb(value)
  return {
    before,
    after,
    diff: computeNotebookDiff(before, after, { matchCellIdsOnly: true }),
  } as ReviewPreview
}
const settings = {
  enabled: true,
  model: 'ft:test',
  organization: '',
  project: '',
  apiKey: 'test-key',
}
beforeEach(() => {
  localStorage.clear()
  vi.mocked(gradeSuggestion).mockReset()
  saveGraderSettings(settings)
})
afterEach(() => vi.restoreAllMocks())
it('does no work for hidden views, predicts on open, and caches exact inputs', async () => {
  vi.mocked(gradeSuggestion).mockResolvedValue({
    accepted: true,
    model: 'ft:test',
    requestId: null,
  })
  const p = preview('new')
  const { result, rerender } = renderHook(
    ({ active }) => useSuggestionPredictions(p, active),
    { initialProps: { active: false } }
  )
  expect(gradeSuggestion).not.toHaveBeenCalled()
  rerender({ active: true })
  await waitFor(() => expect(result.current.get('c0')?.status).toBe('ready'))
  rerender({ active: false })
  rerender({ active: true })
  await waitFor(() => expect(result.current.get('c0')?.status).toBe('ready'))
  expect(gradeSuggestion).toHaveBeenCalledTimes(1)
})
it('cancels obsolete work and never applies a late prediction to another comparison', async () => {
  let finish: (value: any) => void = () => {}
  vi.mocked(gradeSuggestion)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue({ accepted: false, model: 'ft:test', requestId: null })
  const { result, rerender } = renderHook(
    ({ p }) => useSuggestionPredictions(p, true),
    { initialProps: { p: preview('first') } }
  )
  await waitFor(() => expect(gradeSuggestion).toHaveBeenCalledTimes(1))
  const signal = vi.mocked(gradeSuggestion).mock.calls[0][1]
  rerender({ p: preview('second') })
  expect(signal?.aborted).toBe(true)
  await waitFor(() =>
    expect(result.current.get('c0')).toMatchObject({ accepted: false })
  )
  await act(async () =>
    finish({ accepted: true, model: 'ft:test', requestId: null })
  )
  expect(result.current.get('c0')).toMatchObject({ accepted: false })
})
it('bounds concurrency and does not retry failures during rerenders', async () => {
  const finish: Array<(value: any) => void> = []
  vi.mocked(gradeSuggestion).mockImplementation(
    () => new Promise((resolve) => finish.push(resolve))
  )
  const p = preview('new', 3)
  const { result } = renderHook(() => useSuggestionPredictions(p, true))
  await waitFor(() => expect(gradeSuggestion).toHaveBeenCalledTimes(2))
  await act(async () =>
    finish[0]({ accepted: true, model: 'ft:test', requestId: null })
  )
  await waitFor(() => expect(gradeSuggestion).toHaveBeenCalledTimes(3))
  expect(result.current.get('c0')?.status).toBe('ready')
})
it('clears predictions when disabled and invalidates cache on key/model changes', async () => {
  vi.mocked(gradeSuggestion).mockResolvedValue({
    accepted: true,
    model: 'ft:test',
    requestId: null,
  })
  const p = preview('new')
  const { result } = renderHook(() => useSuggestionPredictions(p, true))
  await waitFor(() => expect(result.current.get('c0')?.status).toBe('ready'))
  act(() => {
    saveGraderSettings({ ...settings, enabled: false })
  })
  expect(result.current.get('c0')?.status).toBe('none')
  act(() => {
    saveGraderSettings({ ...settings, apiKey: 'new-key' })
  })
  await waitFor(() => expect(gradeSuggestion).toHaveBeenCalledTimes(2))
})
it('keeps errors neutral, readable, and cached without retrying', async () => {
  vi.mocked(gradeSuggestion).mockRejectedValue(
    new Error('No prediction: expected exactly true or false')
  )
  const p = preview('new')
  const { result, rerender } = renderHook(() =>
    useSuggestionPredictions(p, true)
  )
  await waitFor(() => expect(result.current.get('c0')?.status).toBe('error'))
  rerender()
  expect(gradeSuggestion).toHaveBeenCalledTimes(1)
  expect(predictionButtonClass(result.current.get('c0'), 'accept')).toBe(
    predictionButtonClass(undefined, 'accept')
  )
})
it('highlights the recommended action only, with distinct accept/reject colors', () => {
  expect(
    predictionButtonClass(
      { status: 'ready', accepted: true, text: 'accept' },
      'accept'
    )
  ).toContain('bg-emerald-700')
  expect(
    predictionButtonClass(
      { status: 'ready', accepted: false, text: 'reject' },
      'undo'
    )
  ).toContain('bg-red-700')
  expect(
    predictionButtonClass(
      { status: 'ready', accepted: false, text: 'reject' },
      'accept'
    )
  ).toContain('bg-slate-100')
})
