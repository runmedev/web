// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveOpenAIAuth } from './openaiTraining'
import {
  getGraderSettings,
  gradeSuggestion,
  parseGraderResponse,
  saveGraderSettings,
  subscribeGraderSettings,
} from './suggestionGrader'
import { encodeSftExample } from './trainingExamples/encoding'
import type { PreparedExample } from './trainingExamples/payloads'

const input: PreparedExample = {
  initial: [],
  operations: [
    {
      kind: 'cell.create',
      payload: {
        cell_id: 'private-id',
        position: [[1, 'private-author', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Hello',
          metadata: { author: 'secret' },
        },
      },
    },
  ],
}
const settings = {
  enabled: true,
  model: 'ft:test',
  organization: 'org-test',
  project: 'proj-test',
}
const response = (text: string, extra = {}) => ({
  status: 'completed',
  output: [
    { type: 'reasoning' },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
  ...extra,
})
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('suggestion grader', () => {
  it('is off by default and never exposes a saved key', () => {
    expect(getGraderSettings().enabled).toBe(false)
    saveGraderSettings({ ...settings, apiKey: 'test-secret' })
    expect(JSON.stringify(getGraderSettings())).not.toContain('test-secret')
    saveGraderSettings({ ...settings, model: 'ft:other' })
    expect(getGraderSettings().hasDedicatedKey).toBe(true)
    saveGraderSettings({ ...settings, apiKey: '' })
    expect(getGraderSettings().hasApiKey).toBe(false)
  })
  it('sends the exact training prompt with labels/metadata excluded', async () => {
    saveOpenAIAuth('test-key', 'https://api.openai.com/v1')
    saveGraderSettings(settings)
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(response('true')), {
          headers: { 'x-request-id': 'req-test' },
        })
      )
    expect(await gradeSuggestion(input)).toEqual({
      accepted: true,
      model: 'ft:test',
      requestId: 'req-test',
    })
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(init?.redirect).toBe('error')
    expect(init?.credentials).toBe('omit')
    expect(new Headers(init?.headers).get('OpenAI-Project')).toBe('proj-test')
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-key'
    )
    const body = JSON.parse(init?.body as string)
    expect(body.input).toBe(encodeSftExample(input, false).messages[0].content)
    expect(body.store).toBe(false)
    expect(body.input).not.toMatch(
      /test-key|private-author|private-id|reference_answer|secret/
    )
  })
  it('fails closed for disabled, missing key, or different-endpoint credentials', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    await expect(gradeSuggestion(input)).rejects.toThrow('not configured')
    saveGraderSettings(settings)
    await expect(gradeSuggestion(input)).rejects.toThrow('API key')
    saveOpenAIAuth('other-key', 'https://internal.openai.org/v1')
    await expect(gradeSuggestion(input)).rejects.toThrow('different endpoint')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses the shared credential after clearing a dedicated key', async () => {
    saveOpenAIAuth('shared-key', 'https://api.openai.com/v1')
    saveGraderSettings({ ...settings, apiKey: 'dedicated-key' })
    saveGraderSettings({ ...settings, apiKey: '' })
    expect(getGraderSettings()).toMatchObject({
      hasDedicatedKey: false,
      hasApiKey: true,
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(response('false')))
    )
    expect((await gradeSuggestion(input)).accepted).toBe(false)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization'))
      .toBe('Bearer shared-key')
  })
  it('does not reuse a different-endpoint credential after clearing the key', async () => {
    saveOpenAIAuth('internal-key', 'https://internal.openai.org/v1')
    saveGraderSettings({ ...settings, apiKey: '' })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    expect(getGraderSettings().hasApiKey).toBe(false)
    await expect(gradeSuggestion(input)).rejects.toThrow('different endpoint')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not retry or reflect sensitive API error bodies', async () => {
    saveGraderSettings({ ...settings, apiKey: 'test-secret' })
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('test-secret prompt data', { status: 401 })
      )
    await expect(gradeSuggestion(input)).rejects.toThrow('HTTP 401')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('notifies consumers about settings and credential changes', () => {
    const listener = vi.fn(),
      unsubscribe = subscribeGraderSettings(listener)
    saveGraderSettings(settings)
    saveOpenAIAuth('key', 'https://api.openai.com/v1')
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'runme.suggestion-grader.v1' })
    )
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    saveGraderSettings(settings)
    expect(listener).toHaveBeenCalledTimes(3)
  })
  it.each(['false', 'true'])('parses only binary %s', (text) =>
    expect(parseGraderResponse(response(text))).toBe(text === 'true')
  )
  it.each([
    'yes',
    'True',
    'false because...',
    '{"accepted":true}',
    '',
    'truefalse',
  ])('abstains for %j', (text) =>
    expect(() => parseGraderResponse(response(text))).toThrow()
  )
  it('abstains for incomplete responses and refusals', () => {
    expect(() =>
      parseGraderResponse(response('true', { status: 'incomplete' }))
    ).toThrow()
    expect(() =>
      parseGraderResponse({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] },
        ],
      })
    ).toThrow()
  })
})
