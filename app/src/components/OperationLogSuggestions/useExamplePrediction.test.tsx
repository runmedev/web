import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gradeSuggestion, saveGraderSettings } from '../../lib/suggestionGrader'
import { planContentExample } from '../../lib/trainingExamples/payloads'
import { useExamplePrediction } from './useExamplePrediction'

vi.mock('../../lib/suggestionGrader', async (original) => ({
  ...(await original<typeof import('../../lib/suggestionGrader')>()),
  gradeSuggestion: vi.fn(),
}))
const settings = {
  enabled: true,
  model: 'ft:test',
  organization: '',
  project: '',
  apiKey: 'test-key',
}
/** Include two changed cells to ensure inference grades the whole example. */
function input(value: string) {
  return planContentExample({
    initial: [],
    operations: ['a', 'b'].map((cell) => ({
      kind: 'insert' as const,
      cell,
      after: null,
      content: { kind: 'markup' as const, language: 'markdown', value },
    })),
  })
}
beforeEach(() => {
  localStorage.clear()
  vi.mocked(gradeSuggestion).mockReset()
  saveGraderSettings(settings)
})
afterEach(() => localStorage.clear())

it('grades a whole multi-cell example once and reuses exact-input results', async () => {
  const example = input('hello')
  vi.mocked(gradeSuggestion).mockResolvedValue({
    accepted: true,
    model: 'ft:test',
    requestId: null,
  })
  const { result, rerender } = renderHook(
    ({ active }) => useExamplePrediction(example, active),
    { initialProps: { active: false } }
  )
  expect(gradeSuggestion).not.toHaveBeenCalled()
  rerender({ active: true })
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(vi.mocked(gradeSuggestion).mock.calls[0][0]).toBe(example)
  rerender({ active: false })
  rerender({ active: true })
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(gradeSuggestion).toHaveBeenCalledTimes(1)
})

it('cancels obsolete results on navigation/hiding and clears results when configuration changes', async () => {
  let finish!: (value: any) => void
  vi.mocked(gradeSuggestion)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue({ accepted: false, model: 'ft:test', requestId: null })
  const { result, rerender } = renderHook(
    ({ example, active }) => useExamplePrediction(example, active),
    { initialProps: { example: input('first'), active: true } }
  )
  const signal = vi.mocked(gradeSuggestion).mock.calls[0][1]
  const second = input('second')
  rerender({ example: second, active: true })
  expect(signal?.aborted).toBe(true)
  await waitFor(() =>
    expect(result.current).toMatchObject({
      status: 'ready',
      prediction: { accepted: false },
    })
  )
  await act(async () =>
    finish({ accepted: true, model: 'old', requestId: null })
  )
  expect(result.current).toMatchObject({
    status: 'ready',
    prediction: { accepted: false },
  })
  act(() => {
    saveGraderSettings({ ...settings, enabled: false })
  })
  expect(result.current.status).toBe('none')
  act(() => {
    saveGraderSettings({ ...settings, apiKey: 'new-key', model: 'ft:new' })
  })
  await waitFor(() => expect(gradeSuggestion).toHaveBeenCalledTimes(3))
  rerender({ example: second, active: false })
  expect(vi.mocked(gradeSuggestion).mock.calls[2][1]?.aborted).toBe(true)
  expect(result.current.status).toBe('none')
})

it('keeps errors distinct from rejected labels and does not retry on navigation', async () => {
  vi.mocked(gradeSuggestion).mockRejectedValue(new Error('Model unavailable'))
  const example = input('hello')
  const { result, rerender } = renderHook(
    ({ active }) => useExamplePrediction(example, active),
    { initialProps: { active: true } }
  )
  await waitFor(() =>
    expect(result.current).toEqual({
      status: 'error',
      text: 'Model unavailable',
    })
  )
  rerender({ active: false })
  rerender({ active: true })
  await waitFor(() => expect(result.current.status).toBe('error'))
  expect(gradeSuggestion).toHaveBeenCalledTimes(1)
})

it('does not request inference without a key or for empty operations', async () => {
  saveGraderSettings({ ...settings, apiKey: '' })
  const { result, rerender } = renderHook(
    ({ example }) => useExamplePrediction(example, true),
    { initialProps: { example: input('hello') } }
  )
  expect(result.current).toMatchObject({
    status: 'none',
    text: expect.stringContaining('API key'),
  })
  rerender({ example: planContentExample({ initial: [], operations: [] }) })
  act(() => {
    saveGraderSettings(settings)
  })
  expect(result.current).toMatchObject({
    status: 'none',
    text: expect.stringContaining('no content changes'),
  })
  expect(gradeSuggestion).not.toHaveBeenCalled()
})
