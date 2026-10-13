import { setGoogleDriveBaseUrl } from '../lib/googleDriveRuntime'
import type { parser_pb } from '../runme/client'
import {
  type CreationAttemptRecord,
  importLegacyCreationJournal,
} from './legacyCreationJournal'
import type LocalNotebooks from './local'
import {
  type OwnerRequest,
  STORAGE_METHODS,
  STORAGE_OWNER_VERSION,
  encodeStorageError,
} from './storageOwnerProtocol'
import {
  type RecoveryMessage,
  recoveryMessage,
} from './storageRecoveryProtocol'
import { SyncDeferred } from './syncWorkQueue'

/** One SharedWorker owns this host; ports only submit typed storage requests. */
export class StorageOwnerHost {
  private ports = new Map<
    MessagePort,
    { available: boolean; lastSeen: number; credentialBoundary: string }
  >()
  private tokenRequests = new Map<
    string,
    {
      port: MessagePort
      resolve: (value: string) => void
      reject: (error: Error) => void
    }
  >()
  private views = new Map<
    MessagePort,
    Map<
      string,
      Awaited<ReturnType<LocalNotebooks['createOperationLogSaveStore']>>
    >
  >()
  private statusPages = new Map<
    string,
    ReturnType<LocalNotebooks['listFileSyncStatusPage']>
  >()
  private configuredBaseUrl: string | undefined
  private credentialBoundary: string | undefined
  private available = false
  private scanning: Promise<unknown> | undefined
  private inFlight = new Set<Promise<void>>()
  private recovery?: {
    id: string
    ready: Set<MessagePort>
    draining: boolean
    timer?: ReturnType<typeof setTimeout>
  }
  private draining?: Promise<void>

  constructor(
    private readonly store: LocalNotebooks,
    private readonly shutdown?: () => void
  ) {}

  attach(port: MessagePort): void {
    this.ports.set(port, {
      available: false,
      lastSeen: Date.now(),
      credentialBoundary: 'default',
    })
    this.views.set(port, new Map())
    port.onmessage = (event) => {
      if (event.data?.type === 'storage-recovery') {
        this.recover(port, event.data)
        return
      }
      const operation = this.receive(port, event.data)
      this.inFlight.add(operation)
      void operation.then(
        () => this.inFlight.delete(operation),
        () => this.inFlight.delete(operation)
      )
    }
    port.onmessageerror = () => this.detach(port)
    port.start()
    if (this.recovery) {
      port.postMessage(recoveryMessage('prepare', this.recovery.id))
      this.armRecoveryTimeout()
    }
  }

  /** Unversioned control plane: every attached tab must preserve its editor before shutdown. */
  private recover(port: MessagePort, message: RecoveryMessage): void {
    if (!this.ports.has(port) || message.protocol !== 1) return
    if (message.action === 'restart') {
      if (this.recovery && !this.recovery.draining) {
        port.postMessage(recoveryMessage('prepare', this.recovery.id))
        return
      }
      if (!this.shutdown) {
        port.postMessage(
          recoveryMessage(
            'blocked',
            message.id,
            'This storage worker cannot restart itself.'
          )
        )
        return
      }
      const round = {
        id: message.id,
        ready: new Set<MessagePort>(),
        draining: Boolean(this.recovery?.draining),
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      }
      this.recovery = round
      this.armRecoveryTimeout()
      for (const client of this.ports.keys())
        client.postMessage(recoveryMessage('prepare', round.id))
    } else if (message.action === 'ready' && message.id === this.recovery?.id) {
      if (message.error) {
        this.abortRecovery(message.error)
        return
      }
      this.recovery.ready.add(port)
      void this.finishRecovery()
    }
  }

  private armRecoveryTimeout(): void {
    const round = this.recovery
    if (!round) return
    clearTimeout(round.timer)
    round.timer = setTimeout(() => {
      if (this.recovery !== round) return
      this.abortRecovery(
        'Another Runme tab did not acknowledge recovery. Bring all Runme tabs to the foreground and retry. Older tabs may need to be navigated away first.'
      )
    }, 30_000)
  }

  private abortRecovery(error: string): void {
    const round = this.recovery
    if (!round) return
    clearTimeout(round.timer)
    // Once draining starts the queue must stay closed, but a later retry can
    // gather new editor acknowledgements after a late tab fixes its backup error.
    if (!round.draining) this.recovery = undefined
    else round.ready.clear()
    for (const port of this.ports.keys())
      port.postMessage(recoveryMessage('blocked', round.id, error))
  }

  /** No timer may force termination while a storage or network commit is still active. */
  private async finishRecovery(): Promise<void> {
    const round = this.recovery
    if (!round || [...this.ports.keys()].some((port) => !round.ready.has(port)))
      return
    clearTimeout(round.timer)
    for (const port of this.ports.keys())
      port.postMessage(recoveryMessage('draining', round.id))
    if (!round.draining) {
      round.draining = true
      this.draining = (async () => {
        await this.store.ready
        await Promise.allSettled([
          ...this.inFlight,
          ...(this.scanning ? [this.scanning] : []),
        ])
        await this.store.drainForStorageRestart()
      })()
    }
    try {
      await this.draining
      // A tab attached during draining must preserve its editor too.
      if (
        this.recovery !== round ||
        [...this.ports.keys()].some((port) => !round.ready.has(port))
      )
        return
      this.recovery = undefined
      for (const port of this.ports.keys())
        port.postMessage(recoveryMessage('reload', round.id))
      this.shutdown?.()
    } catch {
      // Remain quiescent rather than start a second owner after an uncertain drain.
      for (const port of this.ports.keys())
        port.postMessage(
          recoveryMessage(
            'blocked',
            round.id,
            'Storage is still shutting down. Keep this page open; no forced reload was performed.'
          )
        )
    }
  }

  private detach(port: MessagePort): void {
    this.ports.delete(port)
    this.views.delete(port)
    for (const [id, request] of this.tokenRequests) {
      if (request.port === port) {
        this.tokenRequests.delete(id)
        request.reject(new Error('Credential tab disconnected'))
      }
    }
    port.close()
    this.updateAvailability()
    if (this.recovery) void this.finishRecovery()
  }

  private updateAvailability(): void {
    const available = [...this.ports.values()].some(
      (p) => p.available && Date.now() - p.lastSeen < 60_000
    )
    const recovered = available && !this.available
    this.available = available
    this.store.setDriveSyncAvailable(available)
    if (recovered) void this.rescan(true).catch(() => {})
  }

  /** Recover keys from durable state; concurrent tab wake-ups share one scan. */
  rescan(retryErrors = false): Promise<unknown> {
    if (this.recovery?.draining) return Promise.resolve()
    if (!this.scanning) {
      this.scanning = this.store
        .reconcileDriveBackedFiles({ retryErrors })
        .finally(() => {
          this.scanning = undefined
        })
    }
    return this.scanning
  }

  /** Request credentials only from live, authenticated tabs. Tokens remain in memory. */
  async accessToken(options?: {
    interactive?: boolean
    forceRefresh?: boolean
  }): Promise<string> {
    for (const [port, state] of this.ports) {
      if (
        !state.available ||
        state.credentialBoundary !== this.credentialBoundary ||
        Date.now() - state.lastSeen >= 60_000
      )
        continue
      const id = crypto.randomUUID()
      try {
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.tokenRequests.delete(id)
            reject(new Error('Credential tab did not respond'))
          }, 10_000)
          this.tokenRequests.set(id, {
            port,
            resolve: (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            reject: (error) => {
              clearTimeout(timer)
              reject(error)
            },
          })
          port.postMessage({
            type: 'token',
            id,
            options: { ...options, interactive: false },
            credentialBoundary: state.credentialBoundary,
          })
        })
      } catch {
        /* Another connected tab may have a valid credential. */
      }
    }
    const deferred = new SyncDeferred(120_000)
    deferred.message =
      'Google Drive authentication unavailable; local changes remain saved'
    throw deferred
  }

  event(type: string, detail: unknown): void {
    for (const port of this.ports.keys())
      port.postMessage({ type: 'event', eventType: type, detail })
  }

  notify(uri: string): void {
    for (const port of this.ports.keys())
      port.postMessage({ type: 'changed', uri })
  }

  private async receive(
    port: MessagePort,
    request: OwnerRequest & { token?: string; error?: { message?: string } }
  ): Promise<void> {
    const state = this.ports.get(port)
    if (!state) return
    state.lastSeen = Date.now()
    if ((request as { type: string }).type === 'token-result') {
      const pending = this.tokenRequests.get(request.id)
      if (pending?.port !== port) return
      this.tokenRequests.delete(request.id)
      if (typeof request.token === 'string' && request.token)
        pending.resolve(request.token)
      else
        pending.reject(
          new Error(
            request.error?.message ?? 'Drive authentication unavailable'
          )
        )
      return
    }
    if (request.type !== 'request' || typeof request.id !== 'string') return
    // Closing a stale tab must release its port even when its data protocol differs.
    if (request.method === 'disconnect') {
      this.detach(port)
      return
    }
    try {
      if (
        request.method !== 'disconnect' &&
        request.method !== 'heartbeat' &&
        (this.recovery?.draining || this.recovery?.ready.has(port))
      )
        throw new Error('Storage is restarting. New requests are paused.')
      if (
        typeof request.credentialBoundary === 'string' &&
        state.credentialBoundary !== request.credentialBoundary
      ) {
        state.available = false
        state.credentialBoundary = request.credentialBoundary
        this.updateAvailability()
      }
      if (request.version !== STORAGE_OWNER_VERSION)
        throw new Error(
          'Storage worker version mismatch. Reload all Runme tabs to reconnect.'
        )
      if (!Array.isArray(request.args))
        throw new Error('Invalid storage request arguments')
      if (
        !['hello', 'availability', 'disconnect', 'heartbeat'].includes(
          request.method
        ) &&
        this.credentialBoundary !== undefined &&
        state.credentialBoundary !== this.credentialBoundary
      )
        throw new Error(
          'Drive identity differs from the storage owner; use an isolated browser profile'
        )
      await this.store.ready
      let value: unknown
      switch (request.method) {
        case 'hello':
          {
            // Restore the profile's durable identity before accepting reads or
            // queued writes, even when no tab has authenticated after restart.
            const profileBoundary = (
              request.args[0] as
                | { profileCredentialBoundary?: string }
                | undefined
            )?.profileCredentialBoundary
            if (profileBoundary) {
              if (
                this.credentialBoundary !== undefined &&
                this.credentialBoundary !== profileBoundary
              )
                throw new Error(
                  'Drive identity differs from the storage owner; use an isolated browser profile'
                )
              this.credentialBoundary = profileBoundary
            }
            const baseUrl =
              (request.args[0] as { driveBaseUrl?: string } | undefined)
                ?.driveBaseUrl ?? ''
            state.credentialBoundary =
              (request.args[0] as { credentialBoundary?: string } | undefined)
                ?.credentialBoundary ?? 'default'
            if (
              this.credentialBoundary !== undefined &&
              this.credentialBoundary !== state.credentialBoundary
            )
              throw new Error(
                'Drive identity differs from the storage owner; use an isolated browser profile'
              )
            if (
              this.configuredBaseUrl !== undefined &&
              this.configuredBaseUrl !== baseUrl
            )
              throw new Error(
                'Drive endpoint differs from the storage owner. Reload all Runme tabs after changing settings.'
              )
            await importLegacyCreationJournal(
              this.store.driveCreateAttempts,
              (
                request.args[0] as
                  | { attempts?: CreationAttemptRecord[] }
                  | undefined
              )?.attempts ?? []
            )
            // An invalid old creation identity pauses creation only. Existing
            // notebooks must remain readable and editable while it is repaired.
            this.store.driveCreationRecoveryError = (
              request.args[0] as { creationMigrationError?: string } | undefined
            )?.creationMigrationError
            this.configuredBaseUrl = baseUrl
            setGoogleDriveBaseUrl(baseUrl)
            value = { version: STORAGE_OWNER_VERSION }
          }
          break
        case 'heartbeat':
          this.updateAvailability()
          break
        case 'disconnect':
          this.detach(port)
          return
        case 'availability': {
          state.available = false
          state.credentialBoundary =
            typeof request.args[1] === 'string' ? request.args[1] : 'default'
          if (
            this.credentialBoundary !== undefined &&
            this.credentialBoundary !== state.credentialBoundary
          ) {
            this.updateAvailability()
            throw new Error(
              'Drive identity differs from the storage owner; use an isolated browser profile'
            )
          }
          if (request.args[0] === true)
            this.credentialBoundary = state.credentialBoundary
          state.available = request.args[0] === true
          this.updateAvailability()
          break
        }
        case 'releaseView':
          this.views.get(port)?.delete(String(request.args[0]))
          break
        case 'createView': {
          const [uri, options] = request.args as Parameters<
            LocalNotebooks['createOperationLogSaveStore']
          >
          const view = await this.store.createOperationLogSaveStore(
            uri,
            options
          )
          const id = crypto.randomUUID()
          this.views.get(port)!.set(id, view)
          value = {
            id,
            heads: view.getObservedOperationHeads(),
            initialNotebook: view.initialNotebook,
          }
          break
        }
        case 'saveView': {
          const [id, uri, notebook] = request.args as [
            string,
            string,
            parser_pb.Notebook,
          ]
          const view = this.views.get(port)?.get(id)
          if (!view)
            throw new Error(
              'Notebook view disconnected. Reopen the notebook before saving.'
            )
          await view.save(uri, notebook)
          value = { heads: view.getObservedOperationHeads() }
          break
        }
        case 'listFileSyncStatusPage': {
          const options = request.args[0] as Parameters<
            LocalNotebooks['listFileSyncStatusPage']
          >[0]
          const key = JSON.stringify(options ?? {})
          let page = this.statusPages.get(key)
          if (!page) {
            page = this.store
              .listFileSyncStatusPage(options)
              .finally(() => this.statusPages.delete(key))
            this.statusPages.set(key, page)
          }
          value = await page
          break
        }
        case 'reconcileDriveBackedFiles':
          value = await this.rescan(
            Boolean((request.args[0] as { retryErrors?: boolean })?.retryErrors)
          )
          break
        default: {
          if (!(STORAGE_METHODS as readonly string[]).includes(request.method))
            throw new Error('Unsupported storage operation')
          const method = this.store[
            request.method as (typeof STORAGE_METHODS)[number]
          ] as (...args: unknown[]) => Promise<unknown>
          value = await method.apply(this.store, request.args)
        }
      }
      port.postMessage({ type: 'result', id: request.id, value })
    } catch (error) {
      port.postMessage({
        type: 'result',
        id: request.id,
        error: encodeStorageError(error),
      })
    }
  }
}
