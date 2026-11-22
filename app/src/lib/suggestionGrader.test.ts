// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { keyVault } from './keyvault/store'
import {
  getGraderSettings,
  gradePhrase,
  gradeSuggestion,
  parseGraderResponse,
  saveGraderSettings,
} from './suggestionGrader'
import { mockGraderSources } from './suggestionGraderTestFixture'
import { planContentExample } from './trainingExamples/payloads'

const settings = {
  enabled: true,
  keyName: 'review',
  instructionsUri: 'local://file/rules',
  organization: '',
  project: 'example',
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

it('requires opt-in after migration and persists only the chosen references on save', () => {
  localStorage.setItem(
    'runme.suggestion-grader.v1',
    JSON.stringify({
      enabled: true,
      model: 'ft:old',
      apiKey: 'old-secret',
      project: 'example',
    })
  )
  expect(getGraderSettings()).toMatchObject({
    enabled: false,
    project: 'example',
  })
  saveGraderSettings(settings)
  expect(
    JSON.parse(localStorage.getItem('runme.suggestion-grader.v1')!)
  ).toEqual(settings)
})

it('sends the current rubric and content-only candidate to Decisions with the named key', async () => {
  const read = mockGraderSources()
  saveGraderSettings(settings)
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            model: 'gpt-6-luna',
            answers: [{ type: 'choice', name: 'review', choice: 'accept' }],
          }),
          { headers: { 'x-request-id': 'example' } }
        )
    )
  const candidate = planContentExample({
    initial: [],
    operations: [
      {
        kind: 'insert',
        cell: 'private-id',
        after: null,
        content: { kind: 'markup', language: 'markdown', value: 'Hello' },
      },
    ],
  })
  expect(await gradeSuggestion(candidate)).toEqual({
    accepted: true,
    model: 'gpt-6-luna',
    requestId: 'example',
  })
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe('https://api.openai.com/v1/decisions')
  expect(new Headers(init?.headers).get('Authorization')).toBe(
    'Bearer test-key'
  )
  const body = JSON.parse(String(init?.body))
  expect(body.questions).toEqual([
    {
      type: 'choice',
      name: 'review',
      instructions: 'Accept clear prose.',
      choices: [{ value: 'accept' }, { value: 'reject' }],
    },
  ])
  expect(body.input).toContain('Hello')
  expect(body.input).not.toContain('private-id')
  read.mockResolvedValue('Reject abbreviations.')
  await gradePhrase({ text: 'e.g.' })
  expect(String(fetcher.mock.calls[1][1]?.body)).toContain(
    'Reject abbreviations.'
  )
})
it('abstains for missing instructions and a locked or deleted vault key', async () => {
  const read = mockGraderSources()
  saveGraderSettings(settings)
  const fetcher = vi.spyOn(globalThis, 'fetch')
  read.mockRejectedValueOnce(new Error('Mount the instructions notebook'))
  await expect(gradePhrase({ text: 'test' })).rejects.toThrow('Mount')
  vi.mocked(keyVault.requireValue).mockImplementation(() => {
    throw new Error('Unlock Key Vault')
  })
  await expect(gradePhrase({ text: 'test' })).rejects.toThrow('Unlock')
  expect(fetcher).not.toHaveBeenCalled()
})
it('distinguishes reject from refusal, malformed and mismatched answers', () => {
  const choice = { name: 'review', type: 'choice', choice: 'reject' }
  expect(parseGraderResponse({ answers: [choice] })).toBe(false)
  for (const answers of [
    [],
    [choice, choice],
    [{ ...choice, type: 'refusal' }],
    [{ ...choice, name: 'other' }],
    [{ ...choice, choice: 'maybe' }],
  ])
    expect(() => parseGraderResponse({ answers })).toThrow()
})
