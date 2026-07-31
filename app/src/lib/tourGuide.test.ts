// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  dismissTour,
  listTourTargets,
  showTourStep,
  tourGuideStore,
} from './tourGuide'

describe('tourGuide', () => {
  afterEach(() => {
    dismissTour()
  })

  it('publishes a normalized tour step to subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = tourGuideStore.subscribe(listener)

    const step = showTourStep({
      target: 'left-nav.google-drive',
      message: '  Click here to connect Google Drive.  ',
      title: 'Sign in',
      placement: 'right',
    })

    expect(tourGuideStore.getSnapshot()).toEqual(step)
    expect(step).toMatchObject({
      target: 'left-nav.google-drive',
      message: 'Click here to connect Google Drive.',
      title: 'Sign in',
      placement: 'right',
    })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('replaces the active step when the next tour element is shown', () => {
    const listener = vi.fn()
    const unsubscribe = tourGuideStore.subscribe(listener)

    const first = showTourStep({
      target: 'left-nav.explorer',
      message: 'Browse files here.',
    })
    const second = showTourStep({
      target: 'left-nav.open-documents',
      message: 'See open documents here.',
    })

    expect(second.id).toBe(first.id + 1)
    expect(tourGuideStore.getSnapshot()).toEqual(second)
    expect(tourGuideStore.getSnapshot()).not.toEqual(first)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('rejects unknown targets and empty annotations', () => {
    expect(() =>
      showTourStep({ target: 'button:nth-child(2)', message: 'Click it.' })
    ).toThrow('Unknown tour target')
    expect(() =>
      showTourStep({ target: 'left-nav.explorer', message: ' ' })
    ).toThrow('Tour message is required')
  })

  it('lists stable semantic target ids', () => {
    expect(listTourTargets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'left-nav.explorer' }),
        expect.objectContaining({ id: 'left-nav.google-drive' }),
        expect.objectContaining({ id: 'left-nav.account' }),
      ])
    )
  })
})
