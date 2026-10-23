import { getWorkloadIdentityConfig } from '../auth/workloadIdentity'
import { getGoogleDriveBaseUrl } from '../lib/googleDriveRuntime'
import { appLogger } from '../lib/logging/runtime'
import { DriveCreateNotCommittedError, type DriveNotebookStore } from './drive'
import { FilesystemEntryAlreadyExistsError } from './fs'
import { readLegacyCreationJournal } from './legacyCreationJournal'
import LocalNotebooks, {
  NotebookConflictChangedError,
  OperationLogMutationCommitUncertainError,
} from './local'
import type { StorageOwnerDiagnostics } from './storageOwnerDiagnostics'
import { STORAGE_METHODS, STORAGE_OWNER_VERSION } from './storageOwnerProtocol'
import { requiresStorageReload, storageRecovery } from './storageRecovery'
import { StorageRecoveryClient } from './storageRecoveryClient'
import type { RecoveryMessage } from './storageRecoveryProtocol'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Tab-side RPC transport. No automatic mutation retries after an uncertain result. */
export class StorageOwnerClient {
  private pending = new Map<string, Pending>()
  private closed = false
  private diagnostic?: {
    id: string
    timer: ReturnType<typeof setTimeout>
    resolve: (value: StorageOwnerDiagnostics) => void
    reject: (error: Error) => void
    promise: Promise<StorageOwnerDiagnostics>
  }
  onChange?: (uri: string) => void
  onFailure?: (error: Error) => void
  recovery?: StorageRecoveryClient
  constructor(
    private readonly port: MessagePort,
    private readonly token: DriveNotebookStore['getAccessToken'],
    private readonly getCredentialBoundary: () => string = () => 'default'
  ) {
    port.onmessage = (event) => {
      if (event.data?.type === 'storage-owner-diagnostics') {
        const diagnostic = this.diagnostic
        if (diagnostic && diagnostic.id === event.data.id) {
          clearTimeout(diagnostic.timer)
          diagnostic.resolve(event.data.value)
          this.diagnostic = undefined
        }
        return
      }
      if (event.data?.type === 'storage-recovery') {
        void this.recovery?.receive(event.data as RecoveryMessage)
        return
      }
      void this.receive(event.data)
    }
    port.onmessageerror = () =>
      this.close(
        new Error(
          'Storage worker message failed. Local saves may have committed; reload to recover.'
        )
      )
    port.start()
  }
  /** Coalesce probes outside the data RPC/hello path; never retry the timed-out mutation. */
  diagnose(): Promise<StorageOwnerDiagnostics> {
    if (this.diagnostic) return this.diagnostic.promise
    if (this.closed)
      return Promise.reject(new Error('Storage worker disconnected'))
    const id = crypto.randomUUID()
    let resolve!: (value: StorageOwnerDiagnostics) => void
    let reject!: (error: Error) => void
    const promise = new Promise<StorageOwnerDiagnostics>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(() => {
      this.diagnostic = undefined
      reject(
        new Error(
          'No diagnostic reply: the worker may be unresponsive, disconnected, or lack diagnostics support.'
        )
      )
    }, 5_000)
    this.diagnostic = { id, timer, resolve, reject, promise }
    try {
      this.port.postMessage({ type: 'storage-owner-diagnostics', id })
    } catch (error) {
      clearTimeout(timer)
      this.diagnostic = undefined
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  request(method: string, args: unknown[] = []): Promise<unknown> {
    if (this.closed)
      return Promise.reject(
        new Error(
          'Storage worker disconnected. Reload to recover saved content.'
        )
      )
    const id = crypto.randomUUID()
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          const error = new Error(
            method === 'getDriveQueueMetrics'
              ? 'Storage worker did not respond to queue diagnostics.'
              : 'Storage worker did not acknowledge the request. Its outcome is uncertain; do not repeat creation blindly.'
          )
          appLogger.warn('Storage owner request timed out', {
            attrs: {
              scope: 'storage.owner',
              method,
              requestId: id,
              elapsedMs: Date.now() - startedAt,
              pendingRequests: this.pending.size,
            },
          })
          // One probe per timeout burst. A response proves message-loop liveness,
          // not the outcome of a timed-out commit.
          if (!this.diagnostic)
            void this.diagnose().then(
              (diagnostics) =>
                appLogger.warn('Storage owner diagnostic reply', {
                  attrs: {
                    scope: 'storage.owner',
                    diagnostics: JSON.stringify(diagnostics),
                  },
                }),
              (probeError) =>
                appLogger.warn('Storage owner diagnostics unavailable', {
                  attrs: { scope: 'storage.owner', error: String(probeError) },
                })
            )
          this.onFailure?.(error)
          reject(error)
        },
        method === 'hello' || method === 'getDriveQueueMetrics'
          ? 10_000
          : 300_000
      )
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.port.postMessage({
          type: 'request',
          version: STORAGE_OWNER_VERSION,
          id,
          method,
          args,
          credentialBoundary: this.getCredentialBoundary(),
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  private async receive(message: {
    type: string
    eventType?: string
    detail?: unknown
    id: string
    uri: string
    value: unknown
    error?: Record<string, unknown>
    options?: { forceRefresh?: boolean }
    credentialBoundary?: string
  }) {
    if (message.type === 'event' && message.eventType) {
      window.dispatchEvent(
        new CustomEvent(message.eventType, { detail: message.detail })
      )
      return
    }
    if (message.type === 'changed') {
      this.onChange?.(message.uri)
      return
    }
    if (message.type === 'token') {
      try {
        const boundary = this.getCredentialBoundary()
        if (
          message.credentialBoundary !== undefined &&
          boundary !== message.credentialBoundary
        )
          throw new Error('Drive credential identity changed')
        const token = await this.token({
          ...message.options,
          interactive: false,
        })
        if (this.getCredentialBoundary() !== boundary)
          throw new Error('Drive credential identity changed')
        this.port.postMessage({ type: 'token-result', id: message.id, token })
      } catch (error) {
        this.port.postMessage({
          type: 'token-result',
          id: message.id,
          error: { message: String(error) },
        })
      }
      return
    }
    if (message.type !== 'result') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      const error = Object.assign(
        new Error(String(message.error.message)),
        message.error
      )
      this.onFailure?.(error)
      // Preserve error types that drive editor recovery and creation UI choices.
      if (error.name === 'OperationLogMutationCommitUncertainError')
        Object.setPrototypeOf(
          error,
          OperationLogMutationCommitUncertainError.prototype
        )
      if (error.name === 'NotebookConflictChangedError')
        Object.setPrototypeOf(error, NotebookConflictChangedError.prototype)
      if (error.name === 'DriveCreateNotCommittedError')
        Object.setPrototypeOf(error, DriveCreateNotCommittedError.prototype)
      if (error.name === 'FilesystemEntryAlreadyExistsError')
        Object.setPrototypeOf(
          error,
          FilesystemEntryAlreadyExistsError.prototype
        )
      pending.reject(error)
    } else pending.resolve(message.value)
  }
  close(error = new Error('Storage worker disconnected')): void {
    this.recovery?.disconnected()
    this.onFailure?.(error)
    this.closed = true
    if (this.diagnostic) {
      clearTimeout(this.diagnostic.timer)
      this.diagnostic.reject(error)
      this.diagnostic = undefined
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.port.close()
  }
}

/**
 * Preserve the app's store API and local Dexie live-query readers while routing
 * all notebook operations to the owner. Unsupported workers fail visibly: we
 * must never silently create a competing tab-owned storage writer.
 */
export function createSharedNotebookStore(
  drive: DriveNotebookStore
): LocalNotebooks {
  const worker = new SharedWorker(
    new URL('./storageOwner.worker.ts', import.meta.url),
    { type: 'module', name: 'runme-storage-owner' }
  )
  const client = new StorageOwnerClient(
    worker.port,
    (options) => drive.getAccessToken(options),
    credentialBoundary
  )
  client.onFailure = (error) => {
    if (requiresStorageReload(error)) storageRecovery.report(error)
  }
  client.recovery = new StorageRecoveryClient(
    (message) => worker.port.postMessage(message),
    () => {
      // This is an acknowledged shutdown, not worker failure. Keep editors frozen
      // until navigation completes so no last keystroke escapes the recovery copy.
      client.onFailure = undefined
      client.recovery = undefined
      client.close()
      window.location.reload()
    }
  )
  storageRecovery.registerRestart(() => client.recovery!.restart())
  // Migration is part of the handshake: do not let a recovery scan generate a
  // second remote identity while an old reserved ID only exists in localStorage.
  const ready = Promise.resolve().then(async () => {
    let attempts: ReturnType<typeof readLegacyCreationJournal> = []
    let creationMigrationError: string | undefined
    try {
      attempts = readLegacyCreationJournal(localStorage)
    } catch (error) {
      creationMigrationError = String(error)
    }
    await client.request('hello', [
      {
        driveBaseUrl: getGoogleDriveBaseUrl(),
        credentialBoundary: credentialBoundary(),
        profileCredentialBoundary: localStorage.getItem(
          'runme/storageCredentialBoundary'
        ),
        attempts,
        creationMigrationError,
      },
    ])
    for (const record of attempts) {
      // Cleanup is optional after durable import. Failure cannot disconnect an
      // otherwise healthy editor or discard its notebook persistence channel.
      try {
        if (localStorage.getItem(record.id) === JSON.stringify(record.attempt))
          localStorage.removeItem(record.id)
      } catch {
        /* A later handshake can safely repeat the import. */
      }
    }
  })
  void ready.catch((error) =>
    appLogger.error('Notebook storage worker unavailable', {
      attrs: { scope: 'storage.owner', error: String(error) },
    })
  )
  worker.onerror = (event) =>
    client.close(
      new Error(
        `Notebook storage worker failed: ${event.message || 'startup error'} (${event.filename}:${event.lineno}). Reload to recover durable edits.`
      )
    )
  const local = new LocalNotebooks(
    drive,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { client: true }
  )
  const listeners = new Map<string, Set<() => void>>()
  client.onChange = (uri) => {
    for (const callback of listeners.get(uri) ?? []) callback()
    window.dispatchEvent(
      new CustomEvent('local-notebook-sync-updated', { detail: { uri } })
    )
    window.dispatchEvent(
      new CustomEvent('local-notebook-updated', { detail: { uri } })
    )
  }
  const call = async (method: string, args: unknown[]) => {
    await ready
    return client.request(method, args)
  }
  const heartbeat = setInterval(
    () => void call('heartbeat', []).catch(() => {}),
    15_000
  )
  window.addEventListener(
    'pagehide',
    (event) => {
      if (event.persisted) return
      clearInterval(heartbeat)
      void client.request('disconnect').catch(() => {})
      client.close()
    }
    // A BFCache round trip must not remove the eventual disconnect handler.
  )
  const methods = new Set<string>(STORAGE_METHODS)
  return new Proxy(local, {
    get(target, key) {
      if (key === 'setFilesystemStore' || key === 'stopSyncQueue')
        return () => {}
      if (key === 'operationLogSupportsConcurrentWriters') return () => true
      if (key === 'setDriveSyncAvailable')
        return (available: boolean) => {
          const boundary = credentialBoundary()
          const saved = localStorage.getItem('runme/storageCredentialBoundary')
          // Existing queued edits belong to this profile's identity. A different
          // workload must use a fresh profile, including after worker restart.
          if (available && saved && saved !== boundary) {
            void call('availability', [false, boundary]).catch(() => {})
            appLogger.warn(
              'Drive identity changed; use an isolated browser profile',
              { attrs: { scope: 'storage.owner' } }
            )
            return
          }
          if (available)
            localStorage.setItem('runme/storageCredentialBoundary', boundary)
          void call('availability', [available, boundary]).catch((error) =>
            appLogger.warn('Storage owner auth update failed', {
              attrs: { scope: 'storage.owner', error: String(error) },
            })
          )
        }
      if (key === 'subscribeSync')
        return (uri: string, callback: () => void) => {
          const set = listeners.get(uri) ?? new Set()
          set.add(callback)
          listeners.set(uri, set)
          return () => {
            set.delete(callback)
            if (!set.size) listeners.delete(uri)
          }
        }
      if (key === 'createOperationLogSaveStore')
        return async (uri: string, options: unknown) => {
          const view = (await call('createView', [uri, options])) as {
            id: string
            heads: string[]
            initialNotebook: Awaited<
              ReturnType<LocalNotebooks['createOperationLogSaveStore']>
            >['initialNotebook']
          }
          return {
            initialNotebook: view.initialNotebook,
            dispose: () => {
              void call('releaseView', [view.id]).catch(() => {})
            },
            getObservedOperationHeads: () => [...view.heads],
            save: async (saveUri: string, notebook: unknown) => {
              const result = (await call('saveView', [
                view.id,
                saveUri,
                notebook,
              ])) as { heads: string[] }
              view.heads = result.heads
            },
          }
        }
      if (typeof key === 'string' && methods.has(key))
        return (...args: unknown[]) => {
          if (key === 'reconcileDriveBackedFiles' && args[0])
            args = [
              {
                retryErrors: (args[0] as { retryErrors?: boolean }).retryErrors,
              },
            ]
          return call(key, args)
        }
      if (
        typeof key === 'string' &&
        Object.prototype.hasOwnProperty.call(LocalNotebooks.prototype, key)
      ) {
        throw new Error(
          `Storage method ${key} must be routed through the SharedWorker`
        )
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// A workload credential must never be borrowed from an unrelated human tab.
function credentialBoundary(): string {
  if (typeof window === 'undefined') return 'default'
  const cfg = getWorkloadIdentityConfig()
  return cfg ? `workload:${JSON.stringify(cfg)}` : 'default'
}
