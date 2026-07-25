// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ONBOARDING_STATE_CHANGED_EVENT,
  ONBOARDING_STORAGE_KEY,
  dismissOnboarding,
  getOnboardingState,
  markOnboardingOpened,
  markOnboardingTaskComplete,
  parseOnboardingState,
} from './onboarding'

describe('onboarding state', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('persists open, dismiss, and task completion state', () => {
    markOnboardingOpened()
    markOnboardingTaskComplete('read-getting-started')
    markOnboardingTaskComplete('read-getting-started')
    dismissOnboarding()

    expect(getOnboardingState()).toEqual({
      version: 1,
      opened: true,
      dismissed: true,
      completedTaskIds: ['read-getting-started'],
    })
  })

  it('reopening clears dismissal without losing progress', () => {
    markOnboardingTaskComplete('create-first-notebook')
    dismissOnboarding()
    markOnboardingOpened()

    expect(getOnboardingState()).toMatchObject({
      opened: true,
      dismissed: false,
      completedTaskIds: ['create-first-notebook'],
    })
  })

  it('ignores malformed and unknown persisted values', () => {
    expect(parseOnboardingState('not-json')).toMatchObject({
      opened: false,
      completedTaskIds: [],
    })
    expect(
      parseOnboardingState(
        JSON.stringify({
          opened: true,
          completedTaskIds: ['run-first-cell', 'unknown-task'],
        })
      )
    ).toMatchObject({
      opened: true,
      completedTaskIds: ['run-first-cell'],
    })
  })

  it('notifies the current tab when state changes', () => {
    const listener = vi.fn()
    window.addEventListener(ONBOARDING_STATE_CHANGED_EVENT, listener)

    markOnboardingTaskComplete('share-notebook')

    expect(listener).toHaveBeenCalledOnce()
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toContain(
      'share-notebook'
    )
  })
})
