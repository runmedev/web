import { LOCAL_FOLDER_URI } from '../storage/local'
import { keyVault } from './keyvault/store'
import { request } from './openaiTraining'
import { appState } from './runtime/AppState'
import {
  type PreparedExample,
  normalizePreparedExample,
} from './trainingExamples/payloads'

const storageKey = 'runme.suggestion-grader.v1'
const changedEvent = 'runme-suggestion-grader-changed'
const model = 'gpt-6-luna'
export interface GraderSettings {
  enabled: boolean
  instructionsUri: string
  keyName: string
  organization: string
  project: string
}
const defaults: GraderSettings = {
  enabled: false,
  instructionsUri: '',
  keyName: '',
  organization: '',
  project: '',
}

/** Read only named preferences. Legacy settings require explicit selection and opt-in. */
function readSettings(): GraderSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
    const text = (key: string) =>
      typeof saved?.[key] === 'string' ? saved[key] : ''
    return {
      enabled:
        saved?.enabled === true &&
        !!text('instructionsUri') &&
        !!text('keyName'),
      instructionsUri: text('instructionsUri'),
      keyName: text('keyName'),
      organization: text('organization'),
      project: text('project'),
    }
  } catch {
    return defaults
  }
}

export function getGraderSettings() {
  const settings = readSettings()
  return {
    ...settings,
    hasApiKey: keyVault.getSnapshot().names.includes(settings.keyName),
  }
}

/** Whitelist fields so neither old plaintext keys nor extra caller fields get persisted. */
export function saveGraderSettings(input: GraderSettings) {
  if (typeof input?.enabled !== 'boolean')
    throw new Error('Choose whether to enable predictions')
  const settings = { ...defaults, enabled: input.enabled }
  for (const field of [
    'instructionsUri',
    'keyName',
    'organization',
    'project',
  ] as const) {
    if (typeof input[field] !== 'string' || /[\r\n]/.test(input[field]))
      throw new Error('Invalid grader settings')
    settings[field] = input[field].trim()
  }
  if (settings.enabled && !settings.instructionsUri.startsWith('local://file/'))
    throw new Error('Select a mounted instructions notebook.')
  if (settings.enabled && !settings.keyName)
    throw new Error('Select a key from Key Vault.')
  localStorage.setItem(storageKey, JSON.stringify(settings))
  window.dispatchEvent(new Event(changedEvent))
  return getGraderSettings()
}

/** Vault lock, rotation, deletion and cross-tab settings edits invalidate visible results. */
export function subscribeGraderSettings(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (!event.key || event.key === storageKey) listener()
  }
  const unsubscribe = keyVault.subscribe(listener)
  window.addEventListener(changedEvent, listener)
  window.addEventListener('storage', storage)
  return () => {
    unsubscribe()
    window.removeEventListener(changedEvent, listener)
    window.removeEventListener('storage', storage)
  }
}

/** Explorer always includes Local Notebooks, even before any folder is mounted. */
function rubricRoots() {
  return [...new Set([LOCAL_FOLDER_URI, ...appState.getWorkspaceItems()])]
}

export async function* listRubrics(signal: AbortSignal) {
  const store = appState.localNotebooks
  if (!store) throw new Error('Local notebook storage is unavailable.')
  const roots = rubricRoots()
  let after: string | undefined
  do {
    const page = await store.listMountedRubrics(roots, after)
    if (signal.aborted) return
    yield page.rows
    after = page.nextAfter
  } while (after && !signal.aborted)
}

export async function readRubric(uri: string, flushEditor = true) {
  const store = appState.localNotebooks
  if (!store) throw new Error('Local notebook storage is unavailable.')
  if (flushEditor) await appState.flushOpenNotebook?.(uri)
  return store.readGradingInstructions(uri, rubricRoots())
}

export interface GraderPrediction {
  accepted: boolean
  model: string
  requestId: string | null
}

/** Only a named binary choice is a prediction. Refusals and malformed answers abstain. */
export function parseGraderResponse(value: any): boolean {
  const answer = value?.answers?.[0]
  if (
    !Array.isArray(value?.answers) ||
    value.answers.length !== 1 ||
    answer?.type !== 'choice' ||
    answer.name !== 'review' ||
    !['accept', 'reject'].includes(answer.choice)
  )
    throw new Error('No prediction: expected an accept or reject choice.')
  return answer.choice === 'accept'
}

/** Capture one rubric per grading action, including a multi-cell agent update. */
export async function prepareGrader() {
  const settings = readSettings()
  if (!settings.enabled) throw new Error('AI predictions are not configured')
  const instructions = await readRubric(settings.instructionsUri)
  return { settings, instructions }
}
type Grader = Awaited<ReturnType<typeof prepareGrader>>

async function decide(
  candidate: string,
  signal?: AbortSignal,
  snapshot?: Grader
): Promise<GraderPrediction> {
  const { settings, instructions } = snapshot ?? (await prepareGrader())
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.organization)
    headers['OpenAI-Organization'] = settings.organization
  if (settings.project) headers['OpenAI-Project'] = settings.project
  const timeout = AbortSignal.timeout(120000)
  const response = await request(
    '/decisions',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: candidate,
        questions: [
          {
            type: 'choice',
            name: 'review',
            instructions,
            choices: [{ value: 'accept' }, { value: 'reject' }],
          },
        ],
      }),
    },
    {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: keyVault.requireValue(settings.keyName),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
  )
  const result = await response.json()
  return {
    accepted: parseGraderResponse(result),
    model: result.model ?? model,
    requestId: response.headers.get('x-request-id'),
  }
}

export async function gradeSuggestion(
  input: PreparedExample,
  signal?: AbortSignal,
  snapshot?: Grader
) {
  if (!input.operations.length)
    throw new Error('No prediction: no content changes')
  return decide(
    JSON.stringify(normalizePreparedExample(input)),
    signal,
    snapshot
  )
}

export async function gradePhrase(
  input: { text: string; context?: string },
  signal?: AbortSignal
) {
  if (
    typeof input?.text !== 'string' ||
    !input.text.trim() ||
    (input.context !== undefined && typeof input.context !== 'string')
  )
    throw new Error('Provide a phrase and optional text context.')
  return decide(
    JSON.stringify({ text: input.text, context: input.context }),
    signal
  )
}
