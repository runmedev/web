export type TourPlacement = 'auto' | 'top' | 'right' | 'bottom' | 'left'

export type TourStepRequest = {
  target: string
  message: string
  title?: string
  placement?: TourPlacement
}

export type TourStep = Required<Pick<TourStepRequest, 'target' | 'message'>> &
  Pick<TourStepRequest, 'title'> & {
    id: number
    placement: TourPlacement
  }

export type TourTarget = {
  id: string
  label: string
  description: string
}

/**
 * Tour targets are semantic product identifiers rather than CSS selectors.
 * React components opt in with a matching data-tour-id attribute, so refactors
 * can change DOM structure without changing the AI-facing contract.
 */
export const TOUR_TARGETS: readonly TourTarget[] = [
  {
    id: 'left-nav.explorer',
    label: 'File Explorer',
    description: 'Browse local, filesystem, and Google Drive notebooks.',
  },
  {
    id: 'left-nav.open-documents',
    label: 'Open Documents',
    description: 'List the documents currently open in the workspace.',
  },
  {
    id: 'left-nav.outline',
    label: 'Outline',
    description: 'Navigate the headings and cells in the current notebook.',
  },
  {
    id: 'left-nav.comments',
    label: 'Comments',
    description: 'Open comments for the current document.',
  },
  {
    id: 'left-nav.app-console',
    label: 'App Console',
    description: 'Open the JavaScript console for app and notebook helpers.',
  },
  {
    id: 'left-nav.logs',
    label: 'Logs',
    description: 'Inspect application and runner diagnostics.',
  },
  {
    id: 'left-nav.runner-status',
    label: 'Runner Status',
    description: 'Inspect notebook runner availability and configuration.',
  },
  {
    id: 'left-nav.google-drive',
    label: 'Google Drive',
    description: 'Sign in to Google Drive and inspect Drive sync status.',
  },
  {
    id: 'left-nav.account',
    label: 'Account',
    description: 'Sign in to or sign out of the Runme web application.',
  },
  {
    id: 'left-nav.documentation',
    label: 'Documentation',
    description: 'Browse the documentation bundled with this Runme version.',
  },
  {
    id: 'left-nav.version',
    label: 'Version Information',
    description: 'Inspect the current Runme Web version and build details.',
  },
] as const

const TOUR_TARGET_IDS = new Set(TOUR_TARGETS.map((target) => target.id))
const MAX_MESSAGE_LENGTH = 2_000
const MAX_TITLE_LENGTH = 120

type TourListener = () => void

let activeStep: TourStep | null = null
let nextStepId = 1
const listeners = new Set<TourListener>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number
): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    throw new Error(`Tour ${field} is required.`)
  }
  if (text.length > maxLength) {
    throw new Error(`Tour ${field} must be ${maxLength} characters or fewer.`)
  }
  return text
}

function normalizePlacement(value: unknown): TourPlacement {
  if (
    value === 'top' ||
    value === 'right' ||
    value === 'bottom' ||
    value === 'left'
  ) {
    return value
  }
  return 'auto'
}

/**
 * Shows one AI-authored annotation anchored to a registered UI target.
 *
 * The tour store is intentionally a singleton. Publishing a step atomically
 * replaces the currently visible step, so callers can build timed tours by
 * repeatedly calling showTourStep without dismissing between steps.
 */
export function showTourStep(request: TourStepRequest): TourStep {
  const target = requiredText(request?.target, 'target', 160)
  if (!TOUR_TARGET_IDS.has(target)) {
    throw new Error(
      `Unknown tour target "${target}". Call tour.listTargets() to discover supported targets.`
    )
  }

  const message = requiredText(request?.message, 'message', MAX_MESSAGE_LENGTH)
  const title = request?.title?.trim()
  if (title && title.length > MAX_TITLE_LENGTH) {
    throw new Error(
      `Tour title must be ${MAX_TITLE_LENGTH} characters or fewer.`
    )
  }

  activeStep = {
    id: nextStepId++,
    target,
    message,
    ...(title ? { title } : {}),
    placement: normalizePlacement(request?.placement),
  }
  notifyListeners()
  return activeStep
}

/** Removes the active tour annotation, if one is visible. */
export function dismissTour(): boolean {
  if (!activeStep) {
    return false
  }
  activeStep = null
  notifyListeners()
  return true
}

/** Returns the semantic targets that an AI may annotate. */
export function listTourTargets(): readonly TourTarget[] {
  return TOUR_TARGETS.map((target) => ({ ...target }))
}

export const tourGuideStore = {
  getSnapshot: (): TourStep | null => activeStep,
  subscribe: (listener: TourListener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
