// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { tourUiController } from '../../lib/tourUiController'
import TourUiStateBridge from './TourUiStateBridge'

const state = vi.hoisted(() => ({ isDriveSyncing: false }))

vi.mock('../../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({ isDriveSyncing: state.isDriveSyncing }),
}))

describe('TourUiStateBridge', () => {
  afterEach(() => {
    tourUiController.resetForTests()
    state.isDriveSyncing = false
  })

  it('publishes non-sensitive React-owned authorization state', () => {
    state.isDriveSyncing = true
    render(<TourUiStateBridge />)

    expect(tourUiController.getSnapshot().googleDriveAuthorized).toBe(true)
  })
})
