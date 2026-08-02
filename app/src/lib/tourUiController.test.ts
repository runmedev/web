// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TourUiController, tourUiController } from './tourUiController'

describe('tourUiController', () => {
  beforeEach(() => {
    window.localStorage.clear()
    tourUiController.resetForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    tourUiController.resetForTests()
    window.localStorage.clear()
  })

  it('publishes immutable typed snapshots and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = tourUiController.subscribe(listener)
    const before = tourUiController.getSnapshot()

    const after = tourUiController.setActivePanel(null)

    expect(before).toMatchObject({ revision: 0, activePanel: 'explorer' })
    expect(after).toMatchObject({ revision: 1, activePanel: null })
    expect(before).not.toBe(after)
    expect(Object.isFrozen(before)).toBe(true)
    expect(Object.isFrozen(after)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    tourUiController.setActivePanel(null)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('defaults to the Explorer when no panel preference is stored', () => {
    expect(new TourUiController().getSnapshot().activePanel).toBe('explorer')
  })

  it('supports imperative panel control that persists the view model', () => {
    tourUiController.setActivePanel('documentation')
    expect(tourUiController.getSnapshot().activePanel).toBe('documentation')
    expect(window.localStorage.getItem('runme.sidePanel.active')).toBe(
      'documentation'
    )

    tourUiController.toggleActivePanel('documentation')
    expect(tourUiController.getSnapshot().activePanel).toBeNull()
    expect(window.localStorage.getItem('runme.sidePanel.active')).toBeNull()
  })

  it('waits for the next revision without missing a state change', async () => {
    const before = tourUiController.getSnapshot()
    const waiting = tourUiController.waitForChange({
      afterRevision: before.revision,
      timeoutMs: 1_000,
    })

    tourUiController.setGoogleDriveAuthorized(true)

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      googleDriveAuthorized: true,
      revision: before.revision + 1,
    })
  })

  it('returns immediately when the state already advanced', async () => {
    const before = tourUiController.getSnapshot()
    tourUiController.recordGoogleDriveFolderAdded()

    await expect(
      tourUiController.waitForChange({ afterRevision: before.revision })
    ).resolves.toMatchObject({
      timedOut: false,
      googleDriveFolderAddedCount: 1,
    })
  })

  it('times out without changing the snapshot', async () => {
    const before = tourUiController.getSnapshot()

    await expect(
      tourUiController.waitForChange({
        afterRevision: before.revision,
        timeoutMs: 1,
      })
    ).resolves.toEqual({ ...before, timedOut: true })
  })

  it('rejects invalid revisions and panel names', async () => {
    await expect(
      tourUiController.waitForChange({ afterRevision: 1 })
    ).rejects.toThrow('newer than the current revision')
    expect(() => tourUiController.setActivePanel('settings' as never)).toThrow(
      'activePanel must be'
    )
  })
})
