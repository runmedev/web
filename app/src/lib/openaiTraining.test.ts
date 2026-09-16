// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearOpenAIAuth,
  getOpenAIAuthStatus,
  getTrainingJob,
  saveOpenAIAuth,
  submitTrainingJob,
  uploadOpenAIJsonl,
  validateOpenAIBaseUrl,
} from './openaiTraining'

describe('explicit OpenAI training requests', () => {
  const fetchMock = vi.fn()
  const job = {
    model: 'chosen-model',
    training_file: 'file-train',
    validation_file: 'file-validation',
  }
  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())
  it('stores, replaces and clears keys without exposing them through status', () => {
    saveOpenAIAuth('test-secret', 'https://api.openai.com/v1/')
    expect(getOpenAIAuthStatus()).toEqual({
      configured: true,
      baseUrl: 'https://api.openai.com/v1',
    })
    saveOpenAIAuth('replacement', 'https://api.openai.com/v1')
    expect(localStorage.getItem('runme.openai.credentials.v1')).not.toContain(
      'test-secret'
    )
    clearOpenAIAuth()
    expect(getOpenAIAuthStatus().configured).toBe(false)
  })
  it('uses saved auth for exactly one submission with no credentials in the result', async () => {
    saveOpenAIAuth('test-secret', 'https://api.openai.com/v1')
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'ftjob-123',
          status: 'queued',
          extra: 'not returned',
        })
      )
    )
    expect(await submitTrainingJob({ job })).toEqual({
      id: 'ftjob-123',
      status: 'queued',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/fine_tuning/jobs')
    expect(init.headers.get('Authorization')).toBe('Bearer test-secret')
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    expect(JSON.parse(init.body)).toEqual(job)
  })
  it('allows an ephemeral explicit key without storing it', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'ftjob-123' }))
    )
    await submitTrainingJob({ job, apiKey: 'ephemeral' })
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe(
      'Bearer ephemeral'
    )
    expect(getOpenAIAuthStatus().configured).toBe(false)
  })
  it('requires auth, distinct split IDs and a valid model before sending', async () => {
    await expect(submitTrainingJob({ job })).rejects.toThrow(
      'Authentication Settings'
    )
    await expect(
      submitTrainingJob({
        job: { ...job, validation_file: 'file-train' },
        apiKey: 'test',
      })
    ).rejects.toThrow('different')
    await expect(
      submitTrainingJob({ job: { ...job, model: '' }, apiKey: 'test' })
    ).rejects.toThrow('model')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not forward a saved key to a different endpoint', async () => {
    saveOpenAIAuth('test-secret', 'https://api.openai.com/v1')
    await expect(
      submitTrainingJob({ job, baseUrl: 'https://other.openai.org/v1' })
    ).rejects.toThrow('different endpoint')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([
    'http://api.openai.com/v1',
    'https://api.openai.com.evil.test/v1',
    'https://api.openai.com/v1?x=y',
    'https://user:pass@api.openai.com/v1',
    'https://api.openai.com/v1/files',
  ])('rejects unsafe destination %s', (url) => {
    expect(() => validateOpenAIBaseUrl(url)).toThrow()
  })
  it('does not retry or expose raw transport/server errors', async () => {
    fetchMock.mockRejectedValue(new Error('secret-response-test-secret'))
    await expect(
      submitTrainingJob({ job, apiKey: 'test-secret' })
    ).rejects.toThrow('reconcile')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(
      new Response('secret-response', { status: 401 })
    )
    await expect(
      submitTrainingJob({ job, apiKey: 'test-secret' })
    ).rejects.toThrow('HTTP 401')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('uploads multipart JSONL with purpose fine-tune and lets the browser set the boundary', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'file-123' }))
    )
    await uploadOpenAIJsonl({
      jsonl:
        JSON.stringify({
          messages: [{ role: 'user', content: 'example' }],
          reference_answer: 'true',
        }) + '\n',
      filename: 'train.jsonl',
      apiKey: 'test',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/files')
    expect(init.headers.has('Content-Type')).toBe(false)
    expect(init.body.get('purpose')).toBe('fine-tune')
    expect(init.body.get('file').name).toBe('train.jsonl')
  })
  it('reads a validated job ID with GET', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'ftjob-123', status: 'succeeded' }))
    )
    expect(await getTrainingJob({ id: 'ftjob-123', apiKey: 'test' })).toEqual({
      id: 'ftjob-123',
      status: 'succeeded',
    })
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
    await expect(
      getTrainingJob({ id: '../files', apiKey: 'test' })
    ).rejects.toThrow('job ID')
  })
  it('reports failed storage writes without claiming the key was saved', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota')
      })
    expect(() => saveOpenAIAuth('test', 'https://api.openai.com/v1')).toThrow(
      'Could not save'
    )
    expect(getOpenAIAuthStatus().configured).toBe(false)
    spy.mockRestore()
  })
})
