// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  resetTourWorkflowForTests,
  startTourWorkflow,
} from '../../lib/tourWorkflow'
import TourWorkflowStateBridge from './TourWorkflowStateBridge'

const state = vi.hoisted(() => ({
  isDriveSyncing: false,
  activePanel: null as string | null,
}))

vi.mock('../../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({ isDriveSyncing: state.isDriveSyncing }),
}))

vi.mock('../../contexts/SidePanelContext', () => ({
  useSidePanel: () => ({ activePanel: state.activePanel }),
}))

describe('TourWorkflowStateBridge', () => {
  afterEach(() => {
    resetTourWorkflowForTests()
    state.isDriveSyncing = false
    state.activePanel = null
  })

  it('publishes React-owned auth and panel state', () => {
    state.isDriveSyncing = true
    state.activePanel = 'explorer'
    render(<TourWorkflowStateBridge />)

    expect(startTourWorkflow('add-google-drive-folder').step?.id).toBe(
      'add-google-drive-folder'
    )
  })
})
