import { getWorkloadIdentityConfig } from '../auth/workloadIdentity'
import { getGoogleDriveBaseUrl } from '../lib/googleDriveRuntime'
import { appLogger } from '../lib/logging/runtime'
import {
  type Active,
  OWNER_LOCK,
  RELEASE_CAPABILITIES,
  readControl,
  releasePrefix,
} from '../releases/control'
import { registerUpgradeBlocker } from '../releases/runtime'
import { DriveCreateNotCommittedError, type DriveNotebookStore } from './drive'
import { EditorSaveSession } from './editorSaveSession'
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
import {
  type RecoveryMessage,
  recoveryMessage,
} from './storageRecoveryProtocol'
import { StorageWorkerControl, type WorkerStatus } from './storageWorkerControl'
import {
  acknowledgeTabCheckpoint,
  readTabCheckpoints,
  registerCheckpointTransport,
} from './tabRecoveryCheckpoint'

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Tab-side RPC transport. No automatic mutation retries after an uncertain result. */
export class StorageOwnerClient {
  private pending = new Map<string, Pending>()
  private uncertain = new Set<string>()
  private unresolvedCommit = false
  private closed = false
  private retryConnection = false
  private unregisterDiagnostics?: () => void
  private unregisterReleaseBlocker = registerUpgradeBlocker(() =>
    this.uncertain.size || this.unresolvedCommit
      ? 'A storage operation has an unconfirmed outcome; resolve it before upgrading'
      : undefined
  )
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
    private readonly getCredentialBoundary: () => string = () => 'default',
    private readonly ownerEpoch?: number
  ) {
    port.onmessage = (event) => {
      if (event.data?.type === 'release-owner-error') {
        this.close(
          new Error(
            `Notebook storage worker failed: ${String(event.data.error)}`
          )
        )
        return
      }
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
          'Storage worker message failed. Local saves may have committed; reconnect storage to recover.'
        )
      )
    port.start()
    this.unregisterDiagnostics = storageRecovery.registerDiagnostics(() =>
      this.diagnose()
    )
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

  /** Missing stop notifications must not strand a tab on a dead MessagePort.
   * Safe request timeouts allow the next call to replace this connection. Keep
   * generic uncertain mutations on their original correlation until recovery.
   */
  get needsReconnect(): boolean {
    return this.closed || this.retryConnection
  }

  request(method: string, args: unknown[] = []): Promise<unknown> {
    if (
      (this.uncertain.size || this.unresolvedCommit) &&
      ![
        'disconnect',
        'heartbeat',
        'handshake',
        'hello',
        'commitEditorOperations',
      ].includes(method)
    )
      return Promise.reject(
        new Error(
          'A previous storage operation is still unconfirmed. Wait for its original acknowledgement or use explicit recovery; it will not be replayed.'
        )
      )
    if (this.closed)
      return Promise.reject(
        new Error(
          'Storage worker disconnected. Reconnect to resume pending editor saves.'
        )
      )
    const id = crypto.randomUUID()
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (
            [
              'handshake',
              'hello',
              'heartbeat',
              'commitEditorOperations',
            ].includes(method)
          )
            this.retryConnection = true
          // Keep the original correlation until its late acknowledgement. An
          // upgrade retry must not turn a timed-out mutation into a new mutation.
          if (
            ![
              'hello',
              'handshake',
              'heartbeat',
              'disconnect',
              'getDriveQueueMetrics',
              'commitEditorOperations',
            ].includes(method)
          )
            this.uncertain.add(id)
          else this.pending.delete(id)
          const error = new Error(
            method === 'getDriveQueueMetrics'
              ? 'Storage worker did not respond to queue diagnostics.'
              : method === 'commitEditorOperations'
                ? 'Storage worker did not acknowledge an editor save. Pending operations remain in this tab; reconnect storage to retry them.'
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
        method === 'hello' ||
          method === 'handshake' ||
          method === 'getDriveQueueMetrics'
          ? 10_000
          : 300_000
      )
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.port.postMessage({
          type: 'request',
          version: STORAGE_OWNER_VERSION,
          id,
          method,
          args,
          credentialBoundary: this.getCredentialBoundary(),
          epoch:
            this.ownerEpoch ??
            (typeof window !== 'undefined'
              ? window.runmeRelease?.active.epoch
              : undefined),
          tabId:
            typeof window !== 'undefined'
              ? window.runmeRelease?.tabId
              : undefined,
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
    this.uncertain.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      const error = Object.assign(
        new Error(String(message.error.message)),
        message.error
      )
      this.onFailure?.(error)
      // Preserve error types that drive editor recovery and creation UI choices.
      if (error.name === 'OperationLogMutationCommitUncertainError')
        this.unresolvedCommit = true
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
    this.unregisterDiagnostics?.()
    this.recovery?.disconnected()
    this.onFailure?.(error)
    this.closed = true
    // Losing the transport does not settle an outstanding effect. Keep the
    // upgrade blocker until document reload/recovery; never turn disconnect
    // into an acknowledgement of an uncertain save or create.
    if (
      [...this.pending.values()].some(
        (p) =>
          ![
            'hello',
            'handshake',
            'heartbeat',
            'disconnect',
            'commitEditorOperations',
          ].includes(p.method)
      ) ||
      this.uncertain.size ||
      this.unresolvedCommit
    )
      this.unresolvedCommit = true
    else this.unregisterReleaseBlocker()
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
  const release = window.runmeRelease?.active
  const listeners = new Map<string, Set<() => void>>()
  let recoveryAttemptEpoch: number | undefined
  /** Preserve subscriptions when a new transport replaces a stopped worker. */
  function notifyChange(uri: string) {
    for (const callback of listeners.get(uri) ?? []) callback()
    window.dispatchEvent(
      new CustomEvent('local-notebook-sync-updated', { detail: { uri } })
    )
    window.dispatchEvent(
      new CustomEvent('local-notebook-updated', { detail: { uri } })
    )
  }
  /** A fresh handshake is mandatory for every replacement owner. */
  function connect(selected: Active | undefined = release) {
    const release = selected
    let ownerInstance: string | undefined
    const worker = release
      ? new SharedWorker(
          `${releasePrefix(release.manifest.releaseId)}${release.manifest.owner.entry}`,
          {
            type: 'module',
            name: `runme-storage-owner-${release.manifest.releaseId}-${release.epoch}`,
          }
        )
      : new SharedWorker(new URL('./storageOwner.worker.ts', import.meta.url), {
          type: 'module',
          name: 'runme-storage-owner',
        })
    const client = new StorageOwnerClient(
      worker.port,
      (options) => drive.getAccessToken(options),
      credentialBoundary,
      release?.epoch
    )
    client.onFailure = (error) => {
      if (requiresStorageReload(error)) storageRecovery.report(error)
    }
    worker.port.postMessage(recoveryMessage('register', 'editor-client'))
    // Migration is part of the handshake: do not let a recovery scan generate a
    // second remote identity while an old reserved ID only exists in localStorage.
    const ready = Promise.resolve().then(async () => {
      // This small contract is stable across data-RPC versions and has no
      // storage effects. Incompatibility is distinct from timeout/unavailability.
      const negotiated = (await client.request('handshake')) as {
        protocol: number
        rpcVersion: number
        recoveryFormat: number
        editorCommitVersion: number
      }
      if (
        negotiated.protocol !== 1 ||
        negotiated.rpcVersion !== STORAGE_OWNER_VERSION ||
        negotiated.recoveryFormat !== 1 ||
        negotiated.editorCommitVersion !== 1
      ) {
        const error = new Error(
          'Storage worker is incompatible with this tab. Preserve edits and reload this tab to use the selected application version.'
        )
        error.name = 'StorageWorkerIncompatibleError'
        storageRecovery.set({ phase: 'blocked', message: error.message })
        throw error
      }
      let attempts: ReturnType<typeof readLegacyCreationJournal> = []
      let creationMigrationError: string | undefined
      try {
        attempts = readLegacyCreationJournal(localStorage)
      } catch (error) {
        creationMigrationError = String(error)
      }
      const hello = await client.request('hello', [
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
      const handshake = hello as {
        editorCommitVersion?: number
        version: number
        instanceId?: string
        release?: { releaseId: string; epoch: number; capabilities: string[] }
      }
      if (
        release &&
        (handshake.version !== STORAGE_OWNER_VERSION ||
          !handshake.instanceId ||
          handshake.release?.releaseId !== release.manifest.releaseId ||
          handshake.release.epoch !== release.epoch ||
          RELEASE_CAPABILITIES.some(
            (c) => !handshake.release?.capabilities?.includes(c)
          ))
      )
        throw new Error(
          'Storage owner identity or lifecycle capabilities do not match this tab'
        )
      for (const record of attempts) {
        // Cleanup is optional after durable import. Failure cannot disconnect an
        // otherwise healthy editor or discard its notebook persistence channel.
        try {
          if (
            localStorage.getItem(record.id) === JSON.stringify(record.attempt)
          )
            localStorage.removeItem(record.id)
        } catch {
          /* A later handshake can safely repeat the import. */
        }
      }
      ownerInstance = handshake.instanceId
      return handshake
    })
    void ready.catch(async (error) => {
      appLogger.error('Notebook storage worker unavailable', {
        attrs: { scope: 'storage.owner', error: String(error) },
      })
      // Only an explicit capability mismatch with a different selected release
      // warrants upgrading this tab. Silence/timeouts never authorize a reload.
      if (
        error?.name !== 'StorageWorkerIncompatibleError' ||
        !selected ||
        selected.manifest.releaseId ===
          window.runmeRelease?.active.manifest.releaseId ||
        recoveryAttemptEpoch === selected.epoch ||
        !window.runmeRelease?.prepareReload ||
        !window.runmeVersions?.reloadTab
      )
        return
      recoveryAttemptEpoch = selected.epoch
      try {
        await window.runmeVersions.reloadTab()
      } catch (failure) {
        storageRecovery.set({
          phase: 'blocked',
          message: `This tab could not preserve its state for the selected release: ${String(failure)}. Keep it open and retry recovery.`,
        })
      }
    })
    client.onChange = notifyChange
    worker.onerror = (event) => {
      if (connection.client === client) needsConnection = true
      client.close(
        new Error(
          `Notebook storage worker failed: ${event.message || 'startup error'} (${event.filename}:${event.lineno}). Reconnect storage to resume saving.`
        )
      )
    }
    return {
      worker,
      client,
      ready,
      selected,
      get instanceId() {
        return ownerInstance
      },
    }
  }
  let connection = connect()
  let checkpointing = false
  let needsConnection = false
  let connecting: Promise<void> | undefined
  let retrying: Promise<void> | undefined
  let restartRequested = false
  let driveAvailable = false
  let currentWorker: WorkerStatus | undefined
  let lastManagementReply = 0
  const sessions = new Map<
    EditorSaveSession,
    { disposed: boolean; unregister: () => void }
  >()
  registerCheckpointTransport({
    uris: () =>
      new Set([...sessions.keys()].map((session) => session.getUri())),
    capture: async (editors) => {
      checkpointing = true
      connection.client.onFailure = undefined
      connection.client.close(
        new Error('This tab is preserving editor saves before reload')
      )
      needsConnection = true
      return Promise.all(
        [...sessions.keys()].map((session) =>
          session.checkpoint(editors.get(session.getUri()))
        )
      )
    },
    resume: () => {
      checkpointing = false
      for (const session of sessions.keys())
        session.resumeAfterFailedCheckpoint()
    },
  })
  const management = new StorageWorkerControl((event) => {
    if (
      event.status.releaseId !== connection.selected?.manifest.releaseId ||
      event.status.epoch !== (connection.selected?.epoch ?? 0)
    )
      return
    currentWorker = event.status
    lastManagementReply = Date.now()
    // Status replies are observations only. No tab tells another tab to connect.
    if (event.type === 'stopping')
      storageRecovery.set({
        phase: 'restarting',
        message:
          'Storage is stopping. Editors and pending saves remain in this tab.',
      })
    if (event.type === 'stopped') {
      connection.client.onFailure = undefined
      connection.client.close(
        new Error('Storage worker stopped; pending editor saves retained')
      )
      needsConnection = true
      storageRecovery.set({
        phase: 'required',
        message:
          'Storage stopped. Retry a save or restart storage to reconnect; editors remain open.',
      })
      if (
        event.restart &&
        (restartRequested ||
          [...sessions.keys()].some((session) => session.hasPending))
      )
        void retryPending()
      restartRequested = false
    }
  })
  /** A tab reconnects lazily on its own next request. The browser joins the same
   * named SharedWorker; the worker's lifetime lock remains the only writer gate.
   */
  async function ensureConnected(): Promise<void> {
    if (connection.client.needsReconnect) needsConnection = true
    if (connecting) return connecting
    const selected = release ? await readControl() : undefined
    if (connecting) return connecting
    if (selected?.transition?.phase === 'handoff')
      throw new Error(
        'Storage worker is changing versions. Pending saves remain in this tab; retry after activation.'
      )
    if (release && !selected?.active)
      throw new Error('No active storage worker is selected')
    if (
      selected?.active &&
      selected.active.epoch !== connection.selected?.epoch
    )
      needsConnection = true
    if (!needsConnection) {
      await connection.ready
      return
    }
    const operation = (async () => {
      connection.client.onFailure = undefined
      connection.client.close()
      connection = connect(selected?.active)
      const handshake = await connection.ready
      if (handshake.editorCommitVersion !== 1)
        throw new Error(
          'This worker cannot resume pending editor saves. Keep this tab open and upgrade Runme.'
        )
      needsConnection = false
      if (driveAvailable)
        await connection.client.request('availability', [
          true,
          credentialBoundary(),
        ])
    })()
    connecting = operation
    try {
      await operation
    } catch (error) {
      needsConnection = true
      throw error
    } finally {
      connecting = undefined
    }
  }
  /** Retry only this tab's retained idempotent batches, independently of peers. */
  async function retryPending(): Promise<void> {
    if (retrying) return retrying
    const operation = (async () => {
      try {
        await ensureConnected()
        const results = await Promise.allSettled(
          [...sessions.keys()].map((session) => session.resume())
        )
        for (const [session, state] of sessions) {
          if (state.disposed && !session.hasPending) {
            state.unregister()
            sessions.delete(session)
          }
        }
        const failed = results.filter((result) => result.status === 'rejected')
        storageRecovery.set(
          failed.length
            ? {
                phase: 'blocked',
                message: `${failed.length} notebook save(s) still need recovery. Editors and pending batches remain in this tab.`,
              }
            : { phase: 'healthy', message: '' }
        )
        management.discover()
      } catch (error) {
        storageRecovery.set({
          phase: 'blocked',
          message: `Storage reconnect failed: ${String(error)}. Editors and pending saves remain in this tab.`,
        })
      }
    })()
    retrying = operation
    try {
      await operation
    } finally {
      retrying = undefined
    }
  }
  storageRecovery.registerRestart((force = false) => {
    const requestedAt = Date.now()
    const sendStop = async () => {
      if (
        currentWorker &&
        lastManagementReply >= requestedAt &&
        currentWorker.phase !== 'closing'
      ) {
        restartRequested = true
        management.stop(currentWorker.instanceId, { force, restart: true })
        return
      }
      // Silence alone is not death. A free ownership lock permits reconnecting
      // after a crash without a stopped event; never steal an occupied lock.
      const absent = await navigator.locks.request(
        OWNER_LOCK,
        { mode: 'shared', ifAvailable: true },
        (lock) => Boolean(lock)
      )
      if (absent) {
        connection.client.onFailure = undefined
        connection.client.close()
        needsConnection = true
        void retryPending()
      } else
        storageRecovery.set({
          phase: 'blocked',
          message:
            'No management reply and storage ownership is still held. Keep editors open and use browser worker inspection.',
        })
    }
    management.discover()
    setTimeout(
      () =>
        void sendStop().catch((error) =>
          storageRecovery.report(
            error instanceof Error ? error : new Error(String(error))
          )
        ),
      250
    )
  })
  management.discover()
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
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    if (checkpointing) throw new Error('This tab is preserving pending saves')
    const previous = connection
    const reconnect = needsConnection
    await ensureConnected()
    if (checkpointing) throw new Error('This tab is preserving pending saves')
    if (reconnect || connection !== previous) void retryPending()
    return connection.client.request(method, args)
  }
  const heartbeat = setInterval(() => {
    if (!needsConnection) void call('heartbeat', []).catch(() => {})
  }, 15_000)
  window.addEventListener(
    'pagehide',
    (event) => {
      if (event.persisted) return
      clearInterval(heartbeat)
      void connection.client.request('disconnect').catch(() => {})
      connection.client.close()
      management.close()
    }
    // A BFCache round trip must not remove the eventual disconnect handler.
  )
  const methods = new Set<string>(STORAGE_METHODS)
  return new Proxy(local, {
    get(target, key) {
      if (key === 'ready') return ensureConnected().then(() => connection.ready)
      if (key === 'setFilesystemStore' || key === 'stopSyncQueue')
        return () => {}
      if (key === 'operationLogSupportsConcurrentWriters') return () => true
      if (key === 'setDriveSyncAvailable')
        return (available: boolean) => {
          driveAvailable = available
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
        return async (
          uri: string,
          options: Parameters<
            LocalNotebooks['createOperationLogSaveStore']
          >[1] = {}
        ) => {
          await ensureConnected()
          const handshake = await connection.ready
          if (handshake.editorCommitVersion === 1) {
            const checkpoint = readTabCheckpoints(uri).find(
              (entry) => entry.uri === uri
            )
            const document =
              checkpoint?.document ??
              options.initialDocument ??
              ((await call('loadContent', [uri])) as string)
            const session = new EditorSaveSession(
              uri,
              document,
              async (...args) => {
                await call('commitEditorOperations', args)
              },
              checkpoint?.actorId ?? options.actorId,
              checkpoint
            )
            const state = {
              disposed: false,
              unregister: registerUpgradeBlocker(
                () =>
                  session.hasPending
                    ? 'A notebook has pending editor saves; reconnect storage before upgrading'
                    : undefined,
                true,
                true
              ),
            }
            sessions.set(session, state)
            if (checkpoint) {
              void session
                .save(uri, session.initialNotebook)
                .then(() => acknowledgeTabCheckpoint(uri, checkpoint.actorId))
                .catch((error) =>
                  storageRecovery.report(
                    error instanceof Error ? error : new Error(String(error))
                  )
                )
            }
            return {
              initialNotebook: session.initialNotebook,
              getObservedOperationHeads: () =>
                session.getObservedOperationHeads(),
              save: session.save.bind(session),
              dispose: () => {
                state.disposed = true
                if (!session.hasPending) {
                  state.unregister()
                  sessions.delete(session)
                }
              },
            }
          }
          // Older releases still support their original view protocol. Never
          // assume they understand immutable editor commits merely from version 8.
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
