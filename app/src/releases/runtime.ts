import type {
  Active,
  CommitReference,
  Control,
  Manifest,
  Selection,
} from './control'

/** The independent launcher owns coordination; React registers its durable flush
 * hook only after model initialization. No application import is needed by recovery.
 */
export type ReleaseRuntime = {
  active: Active
  tabId: string
  prepare?: () => Promise<CommitReference[]>
  ready?: () => void
}
declare global {
  interface Window {
    runmeRelease?: ReleaseRuntime
    runmeVersions?: {
      get: () => Promise<Control>
      check: (selection?: Selection) => Promise<void>
      upgrade: () => Promise<void>
      retry: () => Promise<void>
      cancel: () => Promise<void>
      prune: () => Promise<number>
      // Optional because an installed older loader can host a newer app bundle.
      uiVersion?: number
      status?: () => string
      cached?: () => Promise<Manifest[]>
      activate?: (releaseId: string) => Promise<void>
      pin?: () => Promise<void>
    }
  }
}

/** Retire the original loader's floating UI when a newer app hosts version
 * controls. Keep its independent controls reachable while the app is frozen.
 * This adapter is only for protocol-1 loaders predating the Information view.
 */
export function adoptLegacyVersionUi(): () => void {
  if (window.runmeVersions?.uiVersion) return () => {}
  const panel = document.getElementById('runme-release-panel')
  const root = document.getElementById('root')
  if (!panel || !root) return () => {}
  const update = () => {
    panel.hidden = !root.inert
  }
  update()
  const observer = new MutationObserver(update)
  observer.observe(root, { attributes: true, attributeFilter: ['inert'] })
  return () => {
    observer.disconnect()
    panel.hidden = false
  }
}

/** All draft surfaces register blockers before permitting a coordinated reload. */
const blockers = new Map<
  symbol,
  { check: () => string | undefined; retryable: boolean }
>()
export function registerUpgradeBlocker(
  check: () => string | undefined,
  retryable = false
): () => void {
  const id = Symbol()
  blockers.set(id, { check, retryable })
  return () => {
    blockers.delete(id)
  }
}
export function assertNoUpgradeBlockers(): void {
  for (const blocker of blockers.values()) {
    const reason = blocker.check()
    if (reason) {
      const error = new Error(reason)
      if (blocker.retryable) error.name = 'UpgradeBusyError'
      throw error
    }
  }
}

let preparingRelease = false
/** Gate new asynchronous work while an upgrade captures durable local state. */
export function setReleasePreparation(value: boolean): void {
  preparingRelease = value
}
export function assertReleaseWritable(): void {
  if (preparingRelease)
    throw new Error('Runme is preparing an upgrade; new work is paused')
}
