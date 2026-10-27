import type { StorageOwnerDiagnostics } from './storageOwnerDiagnostics'

/** Page-local recovery status shared by the notebook banner and storage status page. */
export type StorageRecoveryState = {
  phase: 'healthy' | 'required' | 'preparing' | 'restarting' | 'blocked'
  message: string
}
let state: StorageRecoveryState = { phase: 'healthy', message: '' }
const listeners = new Set<() => void>()
let restart: (() => void) | undefined
let diagnose: (() => Promise<StorageOwnerDiagnostics>) | undefined
let backup: (() => number) | undefined
let prepare: ((signal: AbortSignal) => Promise<() => void>) | undefined

export const storageRecovery = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  set(next: StorageRecoveryState) {
    state = next
    listeners.forEach((listener) => listener())
  },
  /** Retain the failure even if it occurs before React mounts its views. */
  report(error: Error) {
    if (
      state.phase === 'preparing' ||
      state.phase === 'restarting' ||
      state.phase === 'blocked'
    )
      return
    this.set({ phase: 'required', message: error.message })
  },
  /** Independent of normal RPC admission and release-settings reads. */
  registerDiagnostics(callback: () => Promise<StorageOwnerDiagnostics>) {
    diagnose = callback
    return () => {
      if (diagnose === callback) diagnose = undefined
    }
  },
  diagnose() {
    return diagnose
      ? diagnose()
      : Promise.reject(
          new Error('Storage worker diagnostics are not connected.')
        )
  },
  registerRestart(callback: () => void) {
    restart = callback
  },
  registerPreparation(
    callback: (signal: AbortSignal) => Promise<() => void>,
    backupCallback: () => number
  ) {
    prepare = callback
    backup = backupCallback
    return () => {
      if (prepare === callback) {
        prepare = undefined
        backup = undefined
      }
    }
  },
  backup() {
    if (!backup)
      throw new Error(
        'Notebook recovery is not ready. Wait for the notebook window to load.'
      )
    return backup()
  },
  async prepare(signal: AbortSignal) {
    if (!prepare)
      throw new Error(
        'Notebook recovery is not ready. Wait for the notebook window to load.'
      )
    return prepare(signal)
  },
  restart() {
    if (!restart) return
    restart()
  },
}

export function requiresStorageReload(error: Error): boolean {
  return /Release settings (?:open|read|commit) (?:blocked|timeout|failed)|Storage worker version mismatch|Storage worker disconnected|Storage worker message failed|Notebook storage worker failed|Storage worker did not acknowledge|Storage worker did not respond|Drive endpoint differs from the storage owner/.test(
    error.message
  )
}
