import {
  type TourPlacement,
  type TourStep,
  dismissTour,
  showTourStep,
} from './tourGuide'

export type TourStateValue = boolean | number | string | null

export type TourWorkflowCondition =
  | {
      state: string
      operator: 'equals'
      value: TourStateValue
    }
  | {
      state: string
      operator: 'changed-from-start'
    }

export type TourWorkflowStepDefinition = {
  id: string
  target: string
  title: string
  message: string
  placement?: TourPlacement
  completeWhen: TourWorkflowCondition
}

export type TourWorkflowDefinition = {
  id: string
  label: string
  description: string
  steps: readonly TourWorkflowStepDefinition[]
}

export type TourWorkflowWaitingFor = TourWorkflowCondition & {
  current: TourStateValue | undefined
  baseline: TourStateValue | undefined
}

export type TourWorkflowStatus = {
  sessionId: number
  workflowId: string
  workflowLabel: string
  status: 'waiting' | 'complete'
  revision: number
  step?: Omit<TourWorkflowStepDefinition, 'completeWhen'> & {
    waitingFor: TourWorkflowWaitingFor
  }
}

export type TourWorkflowWaitResult = TourWorkflowStatus & {
  timedOut: boolean
}

type TourWorkflowSession = {
  id: number
  workflow: TourWorkflowDefinition
  baseline: Map<string, TourStateValue | undefined>
}

type StateListener = () => void

export const TOUR_WORKFLOWS: readonly TourWorkflowDefinition[] = [
  {
    id: 'add-google-drive-folder',
    label: 'Add a Google Drive folder',
    description:
      'Authorize Google Drive, open the File Explorer, and add a Drive folder.',
    steps: [
      {
        id: 'authorize-google-drive',
        target: 'left-nav.google-drive',
        title: 'Connect Google Drive',
        message:
          'Click this button to authorize Google Drive. Return here after sign-in completes.',
        placement: 'right',
        completeWhen: {
          state: 'google-drive.authorized',
          operator: 'equals',
          value: true,
        },
      },
      {
        id: 'open-file-explorer',
        target: 'left-nav.explorer',
        title: 'Open the File Explorer',
        message: 'Click this button to open the File Explorer.',
        placement: 'right',
        completeWhen: {
          state: 'side-panel.active',
          operator: 'equals',
          value: 'explorer',
        },
      },
      {
        id: 'add-google-drive-folder',
        target: 'explorer.add-google-drive-folder',
        title: 'Add a Google Drive folder',
        message:
          'Click this button, choose a folder in Google Drive, and confirm your selection.',
        placement: 'bottom',
        completeWhen: {
          state: 'google-drive.folder-added-count',
          operator: 'changed-from-start',
        },
      },
    ],
  },
] as const

const MAX_WAIT_MS = 60_000
const stateValues = new Map<string, TourStateValue>([
  ['google-drive.folder-added-count', 0],
])
const stateListeners = new Set<StateListener>()
let stateRevision = 0
let nextSessionId = 1
let activeSession: TourWorkflowSession | null = null

function cloneCondition(
  condition: TourWorkflowCondition
): TourWorkflowCondition {
  return condition.operator === 'equals'
    ? { ...condition }
    : { state: condition.state, operator: condition.operator }
}

function cloneWorkflow(
  workflow: TourWorkflowDefinition
): TourWorkflowDefinition {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({
      ...step,
      completeWhen: cloneCondition(step.completeWhen),
    })),
  }
}

function getWorkflow(workflowId: string): TourWorkflowDefinition {
  const workflow = TOUR_WORKFLOWS.find(({ id }) => id === workflowId)
  if (!workflow) {
    throw new Error(
      `Unknown tour workflow "${workflowId}". Call tour.listWorkflows() to discover supported workflows.`
    )
  }
  return workflow
}

function getSession(sessionId?: number): TourWorkflowSession {
  if (!activeSession) {
    throw new Error('No tour workflow is active. Call tour.startWorkflow().')
  }
  if (sessionId !== undefined && sessionId !== activeSession.id) {
    throw new Error(
      `Tour workflow session ${sessionId} is no longer active. The active session is ${activeSession.id}.`
    )
  }
  return activeSession
}

function conditionIsComplete(
  condition: TourWorkflowCondition,
  session: TourWorkflowSession
): boolean {
  const current = stateValues.get(condition.state)
  if (condition.operator === 'equals') {
    return Object.is(current, condition.value)
  }
  return !Object.is(current, session.baseline.get(condition.state))
}

function buildStatus(session: TourWorkflowSession): TourWorkflowStatus {
  const step = session.workflow.steps.find(
    (candidate) => !conditionIsComplete(candidate.completeWhen, session)
  )
  const common = {
    sessionId: session.id,
    workflowId: session.workflow.id,
    workflowLabel: session.workflow.label,
    revision: stateRevision,
  }
  if (!step) {
    return { ...common, status: 'complete' }
  }
  return {
    ...common,
    status: 'waiting',
    step: {
      id: step.id,
      target: step.target,
      title: step.title,
      message: step.message,
      ...(step.placement ? { placement: step.placement } : {}),
      waitingFor: {
        ...cloneCondition(step.completeWhen),
        current: stateValues.get(step.completeWhen.state),
        baseline: session.baseline.get(step.completeWhen.state),
      },
    },
  }
}

function notifyStateListeners(): void {
  for (const listener of stateListeners) {
    listener()
  }
}

/** Publishes application state under a stable, agent-facing semantic ID. */
export function publishTourState(id: string, value: TourStateValue): void {
  if (!id.trim()) {
    throw new Error('Tour state id is required.')
  }
  if (Object.is(stateValues.get(id), value) && stateValues.has(id)) {
    return
  }
  stateValues.set(id, value)
  stateRevision += 1
  if (activeSession && buildStatus(activeSession).status === 'complete') {
    dismissTour()
  }
  notifyStateListeners()
}

/** Records a repeatable UI event without exposing DOM events to the agent. */
export function incrementTourState(id: string): number {
  const current = stateValues.get(id)
  const next = typeof current === 'number' ? current + 1 : 1
  publishTourState(id, next)
  return next
}

export function listTourWorkflows(): readonly TourWorkflowDefinition[] {
  return TOUR_WORKFLOWS.map(cloneWorkflow)
}

/** Starts a singleton, resumable workflow and snapshots change-based conditions. */
export function startTourWorkflow(workflowId: string): TourWorkflowStatus {
  const workflow = getWorkflow(workflowId)
  const baseline = new Map<string, TourStateValue | undefined>()
  for (const step of workflow.steps) {
    baseline.set(
      step.completeWhen.state,
      stateValues.get(step.completeWhen.state)
    )
  }
  activeSession = {
    id: nextSessionId++,
    workflow,
    baseline,
  }
  dismissTour()
  notifyStateListeners()
  return buildStatus(activeSession)
}

export function getTourWorkflowStatus(sessionId?: number): TourWorkflowStatus {
  return buildStatus(getSession(sessionId))
}

/** Shows the first incomplete workflow step, using optional AI-authored copy. */
export function showNextTourWorkflowStep(
  sessionId?: number,
  copy?: { title?: string; message?: string }
): TourWorkflowStatus & { tourStep?: TourStep } {
  const status = getTourWorkflowStatus(sessionId)
  if (status.status === 'complete' || !status.step) {
    dismissTour()
    return status
  }
  const tourStep = showTourStep({
    target: status.step.target,
    title: copy?.title ?? status.step.title,
    message: copy?.message ?? status.step.message,
    placement: status.step.placement,
  })
  return { ...status, tourStep }
}

/**
 * Waits for semantic application state to change. The timeout is bounded so a
 * WebMCP call cannot hold the browser indefinitely.
 */
export async function waitForTourWorkflowChange(args: {
  sessionId?: number
  afterRevision: number
  timeoutMs?: number
}): Promise<TourWorkflowWaitResult> {
  const session = getSession(args.sessionId)
  if (!Number.isFinite(args.afterRevision) || args.afterRevision < 0) {
    throw new Error('afterRevision must be a non-negative number.')
  }
  if (stateRevision > args.afterRevision) {
    return { ...buildStatus(session), timedOut: false }
  }
  const timeoutMs = Math.min(
    MAX_WAIT_MS,
    Math.max(1, Math.trunc(args.timeoutMs ?? MAX_WAIT_MS))
  )
  return new Promise<TourWorkflowWaitResult>((resolve, reject) => {
    let settled = false
    const finish = (timedOut: boolean) => {
      if (settled) return
      settled = true
      stateListeners.delete(handleChange)
      window.clearTimeout(timeoutId)
      try {
        resolve({ ...buildStatus(getSession(session.id)), timedOut })
      } catch (error) {
        reject(error)
      }
    }
    const handleChange = () => finish(false)
    const timeoutId = window.setTimeout(() => finish(true), timeoutMs)
    stateListeners.add(handleChange)
  })
}

/** Waits for user progress and then replaces the overlay with the next step. */
export async function continueTourWorkflow(args: {
  sessionId?: number
  afterRevision: number
  timeoutMs?: number
  title?: string
  message?: string
}): Promise<TourWorkflowWaitResult & { tourStep?: TourStep }> {
  const result = await waitForTourWorkflowChange(args)
  if (result.timedOut || result.status === 'complete') {
    if (result.status === 'complete') dismissTour()
    return result
  }
  const shown = showNextTourWorkflowStep(result.sessionId, {
    title: args.title,
    message: args.message,
  })
  return { ...result, tourStep: shown.tourStep }
}

export function cancelTourWorkflow(sessionId?: number): boolean {
  if (!activeSession) return false
  getSession(sessionId)
  activeSession = null
  dismissTour()
  notifyStateListeners()
  return true
}

/** Test-only reset for singleton state. */
export function resetTourWorkflowForTests(): void {
  activeSession = null
  stateValues.clear()
  stateValues.set('google-drive.folder-added-count', 0)
  stateRevision = 0
  nextSessionId = 1
  dismissTour()
  notifyStateListeners()
}
