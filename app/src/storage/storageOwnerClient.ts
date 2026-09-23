import { getGoogleDriveBaseUrl } from '../lib/googleDriveRuntime'
import { appLogger } from '../lib/logging/runtime'
import { DriveCreateNotCommittedError, type DriveNotebookStore } from './drive'
import { FilesystemEntryAlreadyExistsError } from './fs'
import { readLegacyCreationJournal } from './legacyCreationJournal'
import LocalNotebooks, {
  NotebookConflictChangedError,
  OperationLogMutationCommitUncertainError,
} from './local'
import { STORAGE_METHODS, STORAGE_OWNER_VERSION } from './storageOwnerProtocol'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Tab-side RPC transport. No automatic mutation retries after an uncertain result. */
export class StorageOwnerClient {
  private pending = new Map<string, Pending>()
  private closed = false
  onChange?: (uri: string) => void
  constructor(
    private readonly port: MessagePort,
    private readonly token: DriveNotebookStore['getAccessToken']
  ) {
    port.onmessage = (event) => {
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
  request(method: string, args: unknown[] = []): Promise<unknown> {
    if (this.closed)
      return Promise.reject(
        new Error(
          'Storage worker disconnected. Reload to recover saved content.'
        )
      )
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(
            new Error(
              'Storage worker did not acknowledge the request. Its outcome is uncertain; do not repeat creation blindly.'
            )
          )
        },
        method === 'hello' ? 10_000 : 300_000
      )
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.port.postMessage({
          type: 'request',
          version: STORAGE_OWNER_VERSION,
          id,
          method,
          args,
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
        const token = await this.token({
          ...message.options,
          interactive: false,
        })
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
        Object.setPrototypeOf(error, FilesystemEntryAlreadyExistsError.prototype)
      pending.reject(error)
    } else pending.resolve(message.value)
  }
  close(error = new Error('Storage worker disconnected')): void {
    this.closed = true
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
  const client = new StorageOwnerClient(worker.port, (options) =>
    drive.getAccessToken(options)
  )
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
          void call('availability', [available]).catch((error) =>
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
          }
          return {
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
