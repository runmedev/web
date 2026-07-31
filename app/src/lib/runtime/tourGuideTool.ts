import { type TourStepRequest, dismissTour, showTourStep } from '../tourGuide'

type JsonRecord = Record<string, unknown>

export const SHOW_TOUR_STEP_TOOL_NAME = 'showTourStep'
export const SHOW_TOUR_STEP_TOOL_TITLE = 'Show Runme Tour Step'
export const SHOW_TOUR_STEP_TOOL_DESCRIPTION =
  'Highlight a registered Runme UI target and show a short explanatory annotation beside it. Use tour.listTargets() through ExecuteCode to discover target IDs.'

export const DISMISS_TOUR_TOOL_NAME = 'dismissTour'
export const DISMISS_TOUR_TOOL_TITLE = 'Dismiss Runme Tour'
export const DISMISS_TOUR_TOOL_DESCRIPTION =
  'Dismiss the currently visible Runme UI tour annotation.'

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

export function executeShowTourStep(input: JsonRecord): string {
  return JSON.stringify(showTourStep(input as TourStepRequest))
}

export function executeDismissTour(): string {
  return JSON.stringify({ dismissed: dismissTour() })
}
