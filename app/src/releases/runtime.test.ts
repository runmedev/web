import { afterEach, expect, it, vi } from 'vitest'

import { adoptLegacyVersionUi } from './runtime'

afterEach(() => {
  document.body.replaceChildren()
  delete window.runmeVersions
})

it('explicitly hands version controls to the app and releases them on cleanup', () => {
  const release = vi.fn()
  const registerVersionUi = vi.fn(() => release)
  window.runmeVersions = {
    uiVersion: 1,
    registerVersionUi,
  } as unknown as NonNullable<typeof window.runmeVersions>
  const cleanup = adoptLegacyVersionUi()
  expect(registerVersionUi).toHaveBeenCalledOnce()
  cleanup()
  expect(release).toHaveBeenCalledOnce()
})

it('hides the older loader panel while healthy and restores recovery controls while frozen', async () => {
  const root = document.createElement('div')
  root.id = 'root'
  const panel = document.createElement('section')
  panel.id = 'runme-release-panel'
  document.body.append(root, panel)
  const release = adoptLegacyVersionUi()
  expect(panel.hidden).toBe(true)
  root.inert = true
  root.setAttribute('inert', '')
  await Promise.resolve()
  expect(panel.hidden).toBe(false)
  root.inert = false
  root.removeAttribute('inert')
  await Promise.resolve()
  expect(panel.hidden).toBe(true)
  release()
  expect(panel.hidden).toBe(false)
})
