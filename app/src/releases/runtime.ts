import type {
  Active,
  CommitReference,
  Control,
  Manifest,
  ReleaseProgress,
  Selection,
} from './control'
import type { ReleaseAttention } from './releaseAttention'
import type { releaseDatabaseDiagnostics } from './releaseDiagnostics'

/** The independent launcher owns worker activation; React registers this tab’s
 * recovery hook after model initialization. No application import is needed by recovery.
 */
export type ReleaseRuntime = {
  active: Active
  tabId: string
  prepare?: () => Promise<CommitReference[]>
  prepareReload?: () => Promise<void>
  ready?: () => void
}
export type OfflineDownloadStatus = {
  phase: 'downloading' | 'ready' | 'error'
  completed: number
  total: number
  message?: string
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
      diagnostics?: typeof releaseDatabaseDiagnostics
      prepareRecovery?: (selection: Selection) => Promise<Manifest>
      recover?: (selection: Selection) => Promise<void>
      uiVersion?: number
      registerVersionUi?: (options?: { attention?: boolean }) => () => void
      attention?: () => ReleaseAttention | undefined
      status?: () => string
      progress?: () => ReleaseProgress | undefined
      offline?: (releaseId: string) => OfflineDownloadStatus | undefined
      retryOffline?: () => Promise<void>
      cached?: () => Promise<Manifest[]>
      activate?: (releaseId: string) => Promise<void>
      pin?: () => Promise<void>
      reloadTab?: () => Promise<void>
    }
  }
}

/** Explicitly hand version management to this app, or adapt older loaders that
 * predate the handshake. Keep independent controls reachable while frozen.
 */
export function adoptLegacyVersionUi(): () => void {
  if (window.runmeVersions?.registerVersionUi)
    return window.runmeVersions.registerVersionUi({ attention: true })
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

/** Draft surfaces register blockers before permitting this tab to reload. */
const blockers = new Map<
  symbol,
  {
    check: () => string | undefined
    retryable: boolean
    checkpointable: boolean
  }
>()
export function registerUpgradeBlocker(
  check: () => string | undefined,
  retryable = false,
  checkpointable = false
): () => void {
  const id = Symbol()
  blockers.set(id, { check, retryable, checkpointable })
  return () => {
    blockers.delete(id)
  }
}
export function assertNoUpgradeBlockers(checkpointedReload = false): void {
  for (const blocker of blockers.values()) {
    if (checkpointedReload && blocker.checkpointable) continue
    const reason = blocker.check()
    if (reason) {
      const error = new Error(reason)
      if (blocker.retryable) error.name = 'UpgradeBusyError'
      throw error
    }
  }
}

let preparingRelease = false
/** Gate new asynchronous work while this tab captures its reload checkpoint. */
export function setReleasePreparation(value: boolean): void {
  preparingRelease = value
}
export function assertReleaseWritable(): void {
  if (preparingRelease)
    throw new Error('Runme is preparing an upgrade; new work is paused')
}
