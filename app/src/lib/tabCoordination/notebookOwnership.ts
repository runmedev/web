import Dexie, { type Table } from 'dexie'

import { getClaimedSessionId, getTabId } from '../tabIdentity'

export interface NotebookOwnershipRecord {
  notebookUri: string
  ownerTabId: string
  ownerSessionId?: string
  ownerLabel: string
  ownerUrl: string
  ownerStartedAt: string
  epoch: string
}

export type AcquireResult =
  | { status: 'acquired'; lease: NotebookLease }
  | { status: 'blocked'; owner: NotebookOwnershipRecord | null }
  | { status: 'unsupported'; reason: 'web_locks_unavailable' }

export interface NotebookLease {
  notebookUri: string
  tabId: string
  epoch: string
  release(): void
  released: Promise<void>
  isCurrentOwner(): Promise<boolean>
}

export interface ForceReleaseRequest {
  type: 'force-release-request'
  requestId: string
  notebookUri: string
  requesterTabId: string
  requesterSessionId?: string
  requesterLabel: string
  requesterUrl: string
  createdAt: string
  expiresAt: string
  observedOwner?: NotebookOwnershipRecord | null
}

export type ForceReleaseHandlerResult =
  | { status: 'released' }
  | { status: 'not-owner' }
  | { status: 'busy'; message: string }
  | { status: 'failed'; message: string }

export interface ForceReleaseResult {
  type: 'force-release-result'
  requestId: string
  notebookUri: string
  ownerTabId: string
  ownerSessionId?: string
  ownerEpoch: string
  status: ForceReleaseHandlerResult['status']
  message?: string
  releasedAt?: string
}

export type NotebookOwnershipMessage =
  | ForceReleaseRequest
  | ForceReleaseResult
  | {
      type: 'owner-acquired' | 'owner-released'
      record: NotebookOwnershipRecord
    }

export type ForceReleaseRequestResult =
  | { status: 'released' }
  | { status: 'busy' | 'failed' | 'timeout'; message: string }

type ForceReleaseHandler = (
  request: ForceReleaseRequest
) => Promise<ForceReleaseHandlerResult>

interface OwnershipChannel {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void
  ): void
  postMessage(message: unknown): void
  close(): void
}

class NotebookOwnershipDatabase extends Dexie {
  ownership!: Table<NotebookOwnershipRecord, string>

  constructor(databaseName = 'runme-tab-coordination') {
    super(databaseName)
    this.version(1).stores({
      ownership: '&notebookUri, ownerTabId, epoch',
    })
    this.ownership = this.table('ownership')
  }
}

type HeldLease = {
  record: NotebookOwnershipRecord
  release: () => void
  released: Promise<void>
}

type PendingForceRelease = {
  notebookUri: string
  resolve: (result: ForceReleaseRequestResult) => void
  timeout: ReturnType<typeof setTimeout>
}

const FORCE_RELEASE_TIMEOUT_MS = 10_000
const MAX_FORCE_RELEASE_REQUEST_AGE_MS = 60_000
const MAX_PROCESSED_REQUEST_IDS = 1_000

function buildLockName(notebookUri: string): string {
  return `runme:notebook:${notebookUri}`
}

function getOwnerLabel(): string {
  if (typeof document === 'undefined') {
    return 'Runme tab'
  }
  return document.title || 'Runme tab'
}

function getOwnerUrl(): string {
  if (typeof window === 'undefined') {
    return ''
  }
  return window.location.href
}

function hasWebLocks(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function'
  )
}

/**
 * NotebookOwnershipManager owns same-origin exclusive edit leases.
 *
 * Web Locks are the authority. IndexedDB records are diagnostic metadata for
 * blocked UI and are deliberately allowed to be stale.
 */
export class NotebookOwnershipManager {
  private readonly db: NotebookOwnershipDatabase
  private readonly tabId: string
  private readonly heldLeases = new Map<string, HeldLease>()
  private readonly listeners = new Set<() => void>()
  private readonly messageListeners = new Set<
    (message: NotebookOwnershipMessage) => void
  >()
  private readonly channel: OwnershipChannel | null
  private readonly pendingForceReleases = new Map<string, PendingForceRelease>()
  private readonly processedForceReleaseRequests = new Set<string>()
  private forceReleaseHandler: ForceReleaseHandler | null = null

  constructor(options?: {
    dbName?: string
    tabId?: string
    channel?: OwnershipChannel | null
  }) {
    this.db = new NotebookOwnershipDatabase(options?.dbName)
    this.tabId = options?.tabId ?? getTabId()
    this.channel =
      options && Object.prototype.hasOwnProperty.call(options, 'channel')
        ? (options?.channel ?? null)
        : typeof BroadcastChannel === 'function'
          ? new BroadcastChannel('runme-notebook-ownership')
          : null
    this.channel?.addEventListener('message', (event) => {
      this.handleMessage(event.data)
    })
  }

  async acquire(notebookUri: string): Promise<AcquireResult> {
    const existing = this.heldLeases.get(notebookUri)
    if (existing) {
      return {
        status: 'acquired',
        lease: this.createLease(existing.record),
      }
    }
    if (!hasWebLocks()) {
      return { status: 'unsupported', reason: 'web_locks_unavailable' }
    }

    const lockName = buildLockName(notebookUri)
    return new Promise<AcquireResult>((resolve) => {
      let settled = false
      let markReleased!: () => void
      const lockReleased = new Promise<void>((release) => {
        markReleased = release
      })
      const settle = (result: AcquireResult) => {
        if (settled) {
          return
        }
        settled = true
        resolve(result)
      }

      void navigator.locks
        .request(lockName, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            settle({
              status: 'blocked',
              owner: await this.getOwner(notebookUri),
            })
            return
          }

          let releaseLock!: () => void
          const released = new Promise<void>((release) => {
            releaseLock = release
          })
          const record: NotebookOwnershipRecord = {
            notebookUri,
            ownerTabId: this.tabId,
            ownerSessionId: await getClaimedSessionId(),
            ownerLabel: getOwnerLabel(),
            ownerUrl: getOwnerUrl(),
            ownerStartedAt: new Date().toISOString(),
            epoch: crypto.randomUUID(),
          }

          await this.db.ownership.put(record)
          this.heldLeases.set(notebookUri, {
            record,
            release: releaseLock,
            released: lockReleased,
          })
          this.broadcast('owner-acquired', record)
          this.emit()
          settle({
            status: 'acquired',
            lease: this.createLease(record),
          })

          await released
          await this.deleteRecordIfCurrent(record)
          this.heldLeases.delete(notebookUri)
          this.broadcast('owner-released', record)
          this.emit()
        })
        .then(() => {
          markReleased()
        })
        .catch(async () => {
          markReleased()
          settle({
            status: 'blocked',
            owner: await this.getOwner(notebookUri),
          })
        })
    })
  }

  release(notebookUri: string): void {
    const held = this.heldLeases.get(notebookUri)
    if (!held) {
      return
    }
    this.heldLeases.delete(notebookUri)
    held.release()
  }

  async getOwner(notebookUri: string): Promise<NotebookOwnershipRecord | null> {
    return (await this.db.ownership.get(notebookUri)) ?? null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeToMessages(
    listener: (message: NotebookOwnershipMessage) => void
  ): () => void {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  setForceReleaseHandler(handler: ForceReleaseHandler | null): () => void {
    this.forceReleaseHandler = handler
    return () => {
      if (this.forceReleaseHandler === handler) {
        this.forceReleaseHandler = null
      }
    }
  }

  async requestForceRelease(
    notebookUri: string,
    options?: { timeoutMs?: number }
  ): Promise<ForceReleaseRequestResult> {
    if (!this.channel) {
      return {
        status: 'failed',
        message: 'Cross-tab notebook coordination is unavailable.',
      }
    }

    const timeoutMs = options?.timeoutMs ?? FORCE_RELEASE_TIMEOUT_MS
    const now = Date.now()
    const request: ForceReleaseRequest = {
      type: 'force-release-request',
      requestId: crypto.randomUUID(),
      notebookUri,
      requesterTabId: this.tabId,
      requesterSessionId: await getClaimedSessionId(),
      requesterLabel: getOwnerLabel(),
      requesterUrl: getOwnerUrl(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
    }

    return new Promise<ForceReleaseRequestResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingForceReleases.delete(request.requestId)
        resolve({
          status: 'timeout',
          message:
            'The other session did not respond. The notebook is still read-only.',
        })
      }, timeoutMs)
      this.pendingForceReleases.set(request.requestId, {
        notebookUri,
        resolve,
        timeout,
      })
      try {
        this.channel?.postMessage(request)
      } catch (error) {
        clearTimeout(timeout)
        this.pendingForceReleases.delete(request.requestId)
        resolve({
          status: 'failed',
          message: `Could not request write access: ${String(error)}`,
        })
      }
    })
  }

  async isCurrentOwner(notebookUri: string, epoch?: string): Promise<boolean> {
    const held = this.heldLeases.get(notebookUri)
    if (!held) {
      return false
    }
    if (epoch && held.record.epoch !== epoch) {
      return false
    }
    return true
  }

  dispose(): void {
    for (const uri of Array.from(this.heldLeases.keys())) {
      this.release(uri)
    }
    for (const pending of this.pendingForceReleases.values()) {
      clearTimeout(pending.timeout)
      pending.resolve({
        status: 'failed',
        message: 'Notebook ownership manager was disposed.',
      })
    }
    this.pendingForceReleases.clear()
    this.listeners.clear()
    this.messageListeners.clear()
    this.forceReleaseHandler = null
    this.channel?.close()
    void this.db.close()
  }

  private createLease(record: NotebookOwnershipRecord): NotebookLease {
    return {
      notebookUri: record.notebookUri,
      tabId: record.ownerTabId,
      epoch: record.epoch,
      release: () => this.release(record.notebookUri),
      released:
        this.heldLeases.get(record.notebookUri)?.released ?? Promise.resolve(),
      isCurrentOwner: () =>
        this.isCurrentOwner(record.notebookUri, record.epoch),
    }
  }

  private async deleteRecordIfCurrent(
    record: NotebookOwnershipRecord
  ): Promise<void> {
    const current = await this.db.ownership.get(record.notebookUri)
    if (
      current?.ownerTabId === record.ownerTabId &&
      current.epoch === record.epoch
    ) {
      await this.db.ownership.delete(record.notebookUri)
    }
  }

  private broadcast(
    type: 'owner-acquired' | 'owner-released',
    record: NotebookOwnershipRecord
  ): void {
    try {
      this.channel?.postMessage({ type, record })
    } catch {
      // A closing tab can dispose the channel before lock cleanup finishes.
    }
  }

  private handleMessage(value: unknown): void {
    const message = parseOwnershipMessage(value)
    if (!message) {
      return
    }

    this.emitMessage(message)
    this.emit()
    if (message.type === 'force-release-request') {
      this.handleForceReleaseRequest(message)
      return
    }
    if (message.type === 'force-release-result') {
      this.handleForceReleaseResult(message)
      return
    }
    if (message.type === 'owner-released') {
      this.resolveReleasedNotebookRequests(message.record.notebookUri)
    }
  }

  private handleForceReleaseRequest(request: ForceReleaseRequest): void {
    const now = Date.now()
    const createdAt = Date.parse(request.createdAt)
    const expiresAt = Date.parse(request.expiresAt)
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      createdAt < now - MAX_FORCE_RELEASE_REQUEST_AGE_MS ||
      expiresAt <= now ||
      expiresAt <= createdAt ||
      expiresAt > createdAt + MAX_FORCE_RELEASE_REQUEST_AGE_MS ||
      createdAt > now + 60_000 ||
      this.processedForceReleaseRequests.has(request.requestId)
    ) {
      return
    }

    const held = this.heldLeases.get(request.notebookUri)
    const handler = this.forceReleaseHandler
    if (!held || !handler) {
      return
    }
    this.rememberProcessedRequest(request.requestId)

    void handler(request)
      .then((result) => {
        if (result.status === 'not-owner') {
          return
        }
        const response: ForceReleaseResult = {
          type: 'force-release-result',
          requestId: request.requestId,
          notebookUri: request.notebookUri,
          ownerTabId: held.record.ownerTabId,
          ownerSessionId: held.record.ownerSessionId,
          ownerEpoch: held.record.epoch,
          status: result.status,
          ...(result.status === 'released'
            ? { releasedAt: new Date().toISOString() }
            : { message: result.message }),
        }
        try {
          this.channel?.postMessage(response)
        } catch {
          // The requester will time out if the response cannot be delivered.
        }
      })
      .catch((error) => {
        const response: ForceReleaseResult = {
          type: 'force-release-result',
          requestId: request.requestId,
          notebookUri: request.notebookUri,
          ownerTabId: held.record.ownerTabId,
          ownerSessionId: held.record.ownerSessionId,
          ownerEpoch: held.record.epoch,
          status: 'failed',
          message: String(error),
        }
        try {
          this.channel?.postMessage(response)
        } catch {
          // The requester will time out if the response cannot be delivered.
        }
      })
  }

  private handleForceReleaseResult(result: ForceReleaseResult): void {
    const pending = this.pendingForceReleases.get(result.requestId)
    if (!pending || pending.notebookUri !== result.notebookUri) {
      return
    }
    if (result.status === 'not-owner') {
      return
    }
    clearTimeout(pending.timeout)
    this.pendingForceReleases.delete(result.requestId)
    if (result.status === 'released') {
      pending.resolve({ status: 'released' })
      return
    }
    pending.resolve({
      status: result.status,
      message:
        result.message ??
        (result.status === 'busy'
          ? 'The other session is already processing a write-access request.'
          : 'The other session could not release the notebook.'),
    })
  }

  private resolveReleasedNotebookRequests(notebookUri: string): void {
    for (const [requestId, pending] of this.pendingForceReleases) {
      if (pending.notebookUri !== notebookUri) {
        continue
      }
      clearTimeout(pending.timeout)
      this.pendingForceReleases.delete(requestId)
      pending.resolve({ status: 'released' })
    }
  }

  private rememberProcessedRequest(requestId: string): void {
    this.processedForceReleaseRequests.add(requestId)
    if (this.processedForceReleaseRequests.size <= MAX_PROCESSED_REQUEST_IDS) {
      return
    }
    const oldest = this.processedForceReleaseRequests.values().next().value
    if (oldest) {
      this.processedForceReleaseRequests.delete(oldest)
    }
  }

  private emitMessage(message: NotebookOwnershipMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message)
      } catch {
        // Ignore listener failures so ownership messages continue to flow.
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Ignore listener failures so ownership cleanup is not interrupted.
      }
    }
  }
}

function parseOwnershipMessage(
  value: unknown
): NotebookOwnershipMessage | null {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return null
  }
  const message = value as Partial<NotebookOwnershipMessage>
  if (
    (message.type === 'owner-acquired' || message.type === 'owner-released') &&
    'record' in message &&
    message.record &&
    typeof message.record.notebookUri === 'string'
  ) {
    return message as NotebookOwnershipMessage
  }
  if (
    message.type === 'force-release-request' &&
    typeof message.requestId === 'string' &&
    typeof message.notebookUri === 'string' &&
    typeof message.requesterTabId === 'string' &&
    typeof message.createdAt === 'string' &&
    typeof message.expiresAt === 'string'
  ) {
    return message as ForceReleaseRequest
  }
  if (
    message.type === 'force-release-result' &&
    typeof message.requestId === 'string' &&
    typeof message.notebookUri === 'string' &&
    typeof message.ownerTabId === 'string' &&
    typeof message.ownerEpoch === 'string' &&
    (message.status === 'released' ||
      message.status === 'not-owner' ||
      message.status === 'busy' ||
      message.status === 'failed')
  ) {
    return message as ForceReleaseResult
  }
  return null
}

let manager: NotebookOwnershipManager = new NotebookOwnershipManager()

export function getNotebookOwnershipManager(): NotebookOwnershipManager {
  return manager
}

export function __setNotebookOwnershipManagerForTests(
  next: NotebookOwnershipManager
): void {
  manager.dispose()
  manager = next
}

export function __resetNotebookOwnershipManagerForTests(): void {
  manager.dispose()
  manager = new NotebookOwnershipManager()
}
