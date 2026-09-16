import { uploadOpenAIJsonl as uploadJsonl } from './trainingExamples/encoding'

const storageKey = 'runme.openai.credentials.v1'
export const defaultOpenAIBaseUrl = 'https://api.openai.com/v1'
export interface OpenAIAuthOptions {
  apiKey?: string
  baseUrl?: string
  signal?: AbortSignal
}

/** Bind saved credentials to one HTTPS OpenAI endpoint, never a notebook-supplied redirect. */
export function validateOpenAIBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Use an HTTPS OpenAI endpoint ending in /v1')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/v1\/?$/.test(url.pathname) ||
    !['openai.com', 'openai.org'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
  )
    throw new Error('Use an HTTPS OpenAI endpoint ending in /v1')
  return `${url.origin}/v1`
}

/** This browser-only store is deliberately separate from synced notebook state. */
function readCredentials(): { apiKey: string; baseUrl: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!saved || typeof saved.apiKey !== 'string' || !saved.apiKey.trim())
      return null
    return {
      apiKey: saved.apiKey,
      baseUrl: validateOpenAIBaseUrl(saved.baseUrl),
    }
  } catch {
    return null
  }
}

/** Expose presence and destination, not the saved secret, to settings consumers. */
export function getOpenAIAuthStatus() {
  const saved = readCredentials()
  return {
    configured: Boolean(saved),
    baseUrl: saved?.baseUrl ?? defaultOpenAIBaseUrl,
  }
}

/** Save only after explicit consent in Authentication Settings. */
export function saveOpenAIAuth(apiKey: string, baseUrl: string): void {
  const endpoint = validateOpenAIBaseUrl(baseUrl)
  if (!apiKey.trim() || /\s/.test(apiKey.trim()))
    throw new Error('Enter a valid API key')
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ apiKey: apiKey.trim(), baseUrl: endpoint })
    )
  } catch {
    throw new Error('Could not save the OpenAI key in this browser')
  }
}

/** Remove the saved credential without affecting notebooks or Google sign-in. */
export function clearOpenAIAuth(): void {
  try {
    localStorage.removeItem(storageKey)
  } catch {
    throw new Error('Could not clear the OpenAI key in this browser')
  }
}

/** Fixed API paths only; no POST retries, redirects, cookies, or raw response errors. */
async function request(
  path: string,
  init: RequestInit,
  options: OpenAIAuthOptions
) {
  const saved = readCredentials()
  const baseUrl = validateOpenAIBaseUrl(
    options.baseUrl ?? saved?.baseUrl ?? defaultOpenAIBaseUrl
  )
  if (!options.apiKey && saved && baseUrl !== saved.baseUrl)
    throw new Error('The saved API key belongs to a different endpoint')
  const apiKey = options.apiKey ?? saved?.apiKey
  if (!apiKey?.trim())
    throw new Error(
      'Set an OpenAI API key in Authentication Settings or pass apiKey'
    )
  if (/\s/.test(apiKey.trim())) throw new Error('Invalid OpenAI API key')
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${apiKey.trim()}`)
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: options.signal,
      redirect: 'error',
      credentials: 'omit',
    })
  } catch {
    throw new Error(
      'OpenAI request failed or was cancelled. Check network/CORS and reconcile POST results before retrying.'
    )
  }
  if (!response.ok)
    throw new Error(
      `OpenAI request failed (HTTP ${response.status}); reconcile POST results before retrying`
    )
  return response
}

/** Upload an explicitly selected dataset; the saved key never enters notebook outputs. */
export function uploadOpenAIJsonl(
  args: { jsonl: string; filename: string } & OpenAIAuthOptions
) {
  return uploadJsonl({
    ...args,
    requestFiles: (init) => request('/files', init, args),
  })
}

/** Submit exactly once. The caller supplies the target service's complete job schema. */
export async function submitTrainingJob(
  args: { job: Record<string, unknown> } & OpenAIAuthOptions
) {
  const job = args.job
  if (
    !job ||
    typeof job.model !== 'string' ||
    !job.model.trim() ||
    typeof job.training_file !== 'string' ||
    !/^file-[\w-]+$/.test(job.training_file)
  )
    throw new Error('A model and uploaded training_file ID are required')
  if (
    job.validation_file !== undefined &&
    (typeof job.validation_file !== 'string' ||
      !/^file-[\w-]+$/.test(job.validation_file) ||
      job.validation_file === job.training_file)
  )
    throw new Error('validation_file must be a different uploaded file ID')
  const response = await request(
    '/fine_tuning/jobs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    },
    args
  )
  return jobSummary(await readResponse(response))
}

/** Read status without returning training data or arbitrary server fields. */
export async function getTrainingJob(args: { id: string } & OpenAIAuthOptions) {
  if (!/^ftjob-[\w-]+$/.test(args.id))
    throw new Error('Expected a fine-tuning job ID')
  return jobSummary(
    await readResponse(
      await request(`/fine_tuning/jobs/${args.id}`, { method: 'GET' }, args)
    )
  )
}

/** A malformed server body must not become a notebook output through a parser error. */
async function readResponse(response: Response) {
  try {
    return await response.json()
  } catch {
    throw new Error('Invalid OpenAI response; reconcile before retrying')
  }
}

/** Keep responses small; a missing ID is ambiguous and must not trigger a retry. */
function jobSummary(value: { id?: unknown; status?: unknown }) {
  if (typeof value?.id !== 'string' || !/^ftjob-[\w-]+$/.test(value.id))
    throw new Error('Missing job ID; reconcile before retrying')
  return {
    id: value.id,
    status: typeof value.status === 'string' ? value.status : 'unknown',
  }
}
