export const ONBOARDING_DOCUMENT_URI = 'app://onboarding'
export const ONBOARDING_MIME_TYPE = 'application/vnd.runme.onboarding'
export const ONBOARDING_STORAGE_KEY = 'runme/onboarding/v1'
export const ONBOARDING_STATE_CHANGED_EVENT = 'runme:onboarding-state-changed'

export const ONBOARDING_TASK_IDS = [
  'read-getting-started',
  'sign-in-google-drive',
  'add-drive-folder',
  'create-first-notebook',
  'run-first-cell',
  'share-notebook',
] as const

export type OnboardingTaskId = (typeof ONBOARDING_TASK_IDS)[number]

export type OnboardingNotebook = {
  uri: string
  name: string
  remoteUri?: string
}

export type OnboardingState = {
  version: 1
  opened: boolean
  dismissed: boolean
  completedTaskIds: OnboardingTaskId[]
  recentNotebook?: OnboardingNotebook
}

const DEFAULT_STATE: OnboardingState = {
  version: 1,
  opened: false,
  dismissed: false,
  completedTaskIds: [],
}

function isOnboardingTaskId(value: unknown): value is OnboardingTaskId {
  return (
    typeof value === 'string' &&
    ONBOARDING_TASK_IDS.includes(value as OnboardingTaskId)
  )
}

function parseOnboardingNotebook(
  value: unknown
): OnboardingNotebook | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as {
    uri?: unknown
    name?: unknown
    remoteUri?: unknown
  }
  if (typeof candidate.uri !== 'string' || typeof candidate.name !== 'string') {
    return undefined
  }
  return {
    uri: candidate.uri,
    name: candidate.name,
    ...(typeof candidate.remoteUri === 'string' && candidate.remoteUri
      ? { remoteUri: candidate.remoteUri }
      : {}),
  }
}

export function parseOnboardingState(raw: string | null): OnboardingState {
  if (!raw) {
    return DEFAULT_STATE
  }
  try {
    const value = JSON.parse(raw) as {
      version?: unknown
      opened?: unknown
      dismissed?: unknown
      completedTaskIds?: unknown
      recentNotebook?: unknown
    }
    const recentNotebook = parseOnboardingNotebook(value.recentNotebook)
    return {
      version: 1,
      opened: value.opened === true,
      dismissed: value.dismissed === true,
      completedTaskIds: Array.isArray(value.completedTaskIds)
        ? [...new Set(value.completedTaskIds.filter(isOnboardingTaskId))]
        : [],
      ...(recentNotebook ? { recentNotebook } : {}),
    }
  } catch {
    return DEFAULT_STATE
  }
}

export function getOnboardingState(): OnboardingState {
  if (typeof window === 'undefined') {
    return DEFAULT_STATE
  }
  try {
    return parseOnboardingState(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
    )
  } catch {
    return DEFAULT_STATE
  }
}

export function getOnboardingStateSnapshot(): string {
  if (typeof window === 'undefined') {
    return ''
  }
  try {
    return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function subscribeToOnboardingState(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === ONBOARDING_STORAGE_KEY) {
      listener()
    }
  }
  window.addEventListener('storage', handleStorage)
  window.addEventListener(ONBOARDING_STATE_CHANGED_EVENT, listener)
  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(ONBOARDING_STATE_CHANGED_EVENT, listener)
  }
}

function persistOnboardingState(state: OnboardingState): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state))
    window.dispatchEvent(new Event(ONBOARDING_STATE_CHANGED_EVENT))
  } catch {
    // Onboarding should remain usable when browser storage is unavailable.
  }
}

export function hasOpenedOnboarding(): boolean {
  return getOnboardingState().opened
}

export function markOnboardingOpened(): void {
  const state = getOnboardingState()
  persistOnboardingState({ ...state, opened: true, dismissed: false })
}

export function dismissOnboarding(): void {
  const state = getOnboardingState()
  persistOnboardingState({ ...state, opened: true, dismissed: true })
}

export function markOnboardingTaskComplete(taskId: OnboardingTaskId): void {
  const state = getOnboardingState()
  if (state.completedTaskIds.includes(taskId)) {
    return
  }
  persistOnboardingState({
    ...state,
    completedTaskIds: [...state.completedTaskIds, taskId],
  })
}

export function markOnboardingNotebookCreated(
  notebook: OnboardingNotebook
): void {
  const state = getOnboardingState()
  persistOnboardingState({
    ...state,
    completedTaskIds: state.completedTaskIds.includes('create-first-notebook')
      ? state.completedTaskIds
      : [...state.completedTaskIds, 'create-first-notebook'],
    recentNotebook: notebook,
  })
}

export function updateOnboardingNotebookMetadata(
  notebook: OnboardingNotebook
): void {
  const state = getOnboardingState()
  if (state.recentNotebook?.uri !== notebook.uri) {
    return
  }
  persistOnboardingState({
    ...state,
    recentNotebook: notebook,
  })
}
