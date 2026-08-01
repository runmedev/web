import { type TourStepRequest, dismissTour, showTourStep } from '../tourGuide'
import {
  cancelTourWorkflow,
  continueTourWorkflow,
  getTourWorkflowStatus,
  showNextTourWorkflowStep,
  startTourWorkflow,
} from '../tourWorkflow'

type JsonRecord = Record<string, unknown>

export const SHOW_TOUR_STEP_TOOL_NAME = 'showTourStep'
export const SHOW_TOUR_STEP_TOOL_TITLE = 'Show Runme Tour Step'
export const SHOW_TOUR_STEP_TOOL_DESCRIPTION =
  'Highlight a registered Runme UI target and show a short explanatory annotation beside it. Use tour.listTargets() through ExecuteCode to discover target IDs.'

export const DISMISS_TOUR_TOOL_NAME = 'dismissTour'
export const DISMISS_TOUR_TOOL_TITLE = 'Dismiss Runme Tour'
export const DISMISS_TOUR_TOOL_DESCRIPTION =
  'Dismiss the currently visible Runme UI tour annotation.'

export const START_TOUR_WORKFLOW_TOOL_NAME = 'startTourWorkflow'
export const START_TOUR_WORKFLOW_TOOL_TITLE = 'Start Runme Tour Workflow'
export const START_TOUR_WORKFLOW_TOOL_DESCRIPTION =
  'Start a state-aware Runme UI workflow and highlight its first incomplete step. Use this for conditional, multi-step guidance such as adding a Google Drive folder.'

export const CONTINUE_TOUR_WORKFLOW_TOOL_NAME = 'continueTourWorkflow'
export const CONTINUE_TOUR_WORKFLOW_TOOL_TITLE = 'Continue Runme Tour Workflow'
export const CONTINUE_TOUR_WORKFLOW_TOOL_DESCRIPTION =
  'Wait for the user to satisfy the current tour step, then highlight the next incomplete step. Reuse the sessionId and revision returned by the previous workflow call.'

export const GET_TOUR_WORKFLOW_STATUS_TOOL_NAME = 'getTourWorkflowStatus'
export const GET_TOUR_WORKFLOW_STATUS_TOOL_TITLE =
  'Get Runme Tour Workflow Status'
export const GET_TOUR_WORKFLOW_STATUS_TOOL_DESCRIPTION =
  'Inspect the active conditional tour workflow without changing the UI.'

export const CANCEL_TOUR_WORKFLOW_TOOL_NAME = 'cancelTourWorkflow'
export const CANCEL_TOUR_WORKFLOW_TOOL_TITLE = 'Cancel Runme Tour Workflow'
export const CANCEL_TOUR_WORKFLOW_TOOL_DESCRIPTION =
  'Cancel the active conditional tour workflow and dismiss its annotation.'

export function buildShowTourStepInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: { type: 'string' },
      message: { type: 'string' },
      title: { type: 'string' },
      placement: {
        type: 'string',
        enum: ['auto', 'top', 'right', 'bottom', 'left'],
      },
    },
    required: ['target', 'message'],
  }
}

export function buildDismissTourInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
}

const WORKFLOW_COPY_PROPERTIES = {
  title: {
    type: 'string',
    description: 'Optional AI-authored title for the step being shown.',
  },
  message: {
    type: 'string',
    description: 'Optional AI-authored action-oriented text for the step.',
  },
}

export function buildStartTourWorkflowInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      workflowId: {
        type: 'string',
        enum: ['add-google-drive-folder'],
      },
      ...WORKFLOW_COPY_PROPERTIES,
    },
    required: ['workflowId'],
  }
}

export function buildContinueTourWorkflowInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'integer', minimum: 1 },
      afterRevision: { type: 'integer', minimum: 0 },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: 60_000,
        description: 'How long to wait for user progress before returning.',
      },
      ...WORKFLOW_COPY_PROPERTIES,
    },
    required: ['sessionId', 'afterRevision'],
  }
}

export function buildTourWorkflowSessionInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'integer', minimum: 1 },
    },
    required: ['sessionId'],
  }
}

export function executeShowTourStep(input: JsonRecord): string {
  return JSON.stringify(showTourStep(input as TourStepRequest))
}

export function executeDismissTour(): string {
  return JSON.stringify({ dismissed: dismissTour() })
}

export function executeStartTourWorkflow(input: JsonRecord): string {
  const status = startTourWorkflow(String(input.workflowId ?? ''))
  return JSON.stringify(
    showNextTourWorkflowStep(status.sessionId, {
      title: typeof input.title === 'string' ? input.title : undefined,
      message: typeof input.message === 'string' ? input.message : undefined,
    })
  )
}

export async function executeContinueTourWorkflow(
  input: JsonRecord
): Promise<string> {
  return JSON.stringify(
    await continueTourWorkflow({
      sessionId: Number(input.sessionId),
      afterRevision: Number(input.afterRevision),
      timeoutMs:
        typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
      title: typeof input.title === 'string' ? input.title : undefined,
      message: typeof input.message === 'string' ? input.message : undefined,
    })
  )
}

export function executeGetTourWorkflowStatus(input: JsonRecord): string {
  return JSON.stringify(getTourWorkflowStatus(Number(input.sessionId)))
}

export function executeCancelTourWorkflow(input: JsonRecord): string {
  return JSON.stringify({
    cancelled: cancelTourWorkflow(Number(input.sessionId)),
  })
}
