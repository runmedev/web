import { expect, it } from 'vitest'

import { hideLauncherPanel } from './launcherPanelVisibility'

const availableUi = {
  versionUiUsers: 1,
  attentionUiUsers: 1,
  recovery: false,
  frozen: false,
  transitioning: false,
  tabUpdateAvailable: false,
}

it('hands controls to an available app UI without a storage-readiness requirement', () => {
  expect(hideLauncherPanel(availableUi)).toBe(true)
  expect(hideLauncherPanel({ ...availableUi, transitioning: true })).toBe(true)
  expect(hideLauncherPanel({ ...availableUi, tabUpdateAvailable: true })).toBe(true)
})

it('retains fallback before an app registers controls and after its last UI unmounts', () => {
  expect(hideLauncherPanel({ ...availableUi, versionUiUsers: 0 })).toBe(false)
})

it.each(['recovery', 'frozen'] as const)('keeps controls reachable during %s', (reason) => {
  expect(hideLauncherPanel({ ...availableUi, [reason]: true })).toBe(false)
})

it('retains attention controls for older apps without an update indicator', () => {
  const oldUi = { ...availableUi, attentionUiUsers: 0 }
  expect(hideLauncherPanel(oldUi)).toBe(true)
  expect(hideLauncherPanel({ ...oldUi, transitioning: true })).toBe(false)
  expect(hideLauncherPanel({ ...oldUi, tabUpdateAvailable: true })).toBe(false)
})
