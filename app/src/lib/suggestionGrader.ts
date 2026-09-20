import { getOpenAIAuthStatus, request } from './openaiTraining'
import { classifierPrompt } from './trainingExamples/encoding'
import type { PreparedExample } from './trainingExamples/payloads'

const storageKey = 'runme.suggestion-grader.v1'
const changedEvent = 'runme-suggestion-grader-changed'
export interface GraderSettings {
  enabled: boolean
  model: string
  organization: string
  project: string
}
const defaults: GraderSettings = {
  enabled: false,
  model: '',
  organization: '',
  project: '',
}

/** Settings and the optional dedicated key stay on this origin, never in a notebook. */
function readSettings(): GraderSettings & { apiKey?: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (
      !saved ||
      typeof saved.enabled !== 'boolean' ||
      !['model', 'organization', 'project'].every(
        (k) => typeof saved[k] === 'string'
      ) ||
      (saved.apiKey !== undefined && typeof saved.apiKey !== 'string')
    )
      return defaults
    return {
      enabled: saved.enabled,
      model: saved.model,
      organization: saved.organization,
      project: saved.project,
      apiKey: saved.apiKey,
    }
  } catch {
    return defaults
  }
}

/** Return configuration and key presence only, safe for UI and agent inspection. */
export function getGraderSettings() {
  const { apiKey, ...settings } = readSettings()
  const auth = getOpenAIAuthStatus()
  return {
    ...settings,
    hasDedicatedKey: Boolean(apiKey),
    hasApiKey:
      Boolean(apiKey) ||
      (auth.configured && auth.baseUrl === 'https://api.openai.com/v1'),
  }
}

/** An omitted key preserves it; an empty key clears it and uses Authentication Settings. */
export function saveGraderSettings(
  input: GraderSettings & { apiKey?: string }
) {
  if (!input || typeof input.enabled !== 'boolean')
    throw new Error('Choose whether to enable predictions')
  for (const field of ['model', 'organization', 'project'] as const) {
    if (typeof input[field] !== 'string' || /[\r\n]/.test(input[field]))
      throw new Error('Invalid grader settings')
  }
  if (input.enabled && !input.model.trim()) throw new Error('Enter a model ID')
  const apiKey =
    input.apiKey === undefined ? readSettings().apiKey : input.apiKey.trim()
  if (apiKey && /\s/.test(apiKey)) throw new Error('Invalid API key')
  const settings = {
    enabled: input.enabled,
    model: input.model.trim(),
    organization: input.organization.trim(),
    project: input.project.trim(),
    apiKey,
  }
  localStorage.setItem(storageKey, JSON.stringify(settings))
  window.dispatchEvent(new Event(changedEvent))
  return getGraderSettings()
}

/** React and other clients invalidate predictions on settings/key changes in any tab. */
export function subscribeGraderSettings(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (
      !event.key ||
      [storageKey, 'runme.openai.credentials.v1'].includes(event.key)
    )
      listener()
  }
  window.addEventListener(changedEvent, listener)
  window.addEventListener('runme-openai-auth-changed', listener)
  window.addEventListener('storage', storage)
  return () => {
    window.removeEventListener(changedEvent, listener)
    window.removeEventListener('runme-openai-auth-changed', listener)
    window.removeEventListener('storage', storage)
  }
}

export interface GraderPrediction {
  accepted: boolean
  model: string
  requestId: string | null
}

/** Strict binary output, not a confidence score. Refusals/incomplete/malformed results abstain. */
export function parseGraderResponse(value: any): boolean {
  if (
    value?.status !== 'completed' ||
    value.error ||
    !Array.isArray(value.output)
  )
    throw new Error('No prediction: the model did not complete a text response')
  const parts = value.output
    .filter((item: any) => item.type === 'message')
    .flatMap((item: any) => item.content || [])
  if (parts.some((part: any) => part.type === 'refusal'))
    throw new Error('No prediction: model refusal')
  const text = parts
    .filter((part: any) => part.type === 'output_text')
    .map((part: any) => part.text)
    .join('')
    .trim()
  if (text !== 'true' && text !== 'false')
    throw new Error('No prediction: expected exactly true or false')
  return text === 'true'
}

/** Sends content-only input using the training encoder. No labels, decisions, authors,
 * comments, outputs or credentials are included in the prompt. Never retries a POST.
 */
export async function gradeSuggestion(
  input: PreparedExample,
  signal?: AbortSignal
): Promise<GraderPrediction> {
  const settings = readSettings()
  if (!settings.enabled || !settings.model)
    throw new Error('AI predictions are not configured')
  if (!input.operations.length)
    throw new Error('No prediction: no content changes')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.organization)
    headers['OpenAI-Organization'] = settings.organization
  if (settings.project) headers['OpenAI-Project'] = settings.project
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 120000)
  try {
    const response = await request(
      '/responses',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.model,
          input: classifierPrompt(input),
          reasoning: { effort: 'medium' },
          max_output_tokens: 16384,
          store: false,
        }),
      },
      {
        // A cleared dedicated key must use the endpoint-bound shared credential.
        apiKey: settings.apiKey || undefined,
        baseUrl: 'https://api.openai.com/v1',
        signal: controller.signal,
      }
    )
    let result
    try {
      result = await response.json()
    } catch {
      throw new Error('No prediction: invalid response JSON')
    }
    return {
      accepted: parseGraderResponse(result),
      model: settings.model,
      requestId: response.headers.get('x-request-id'),
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
