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
  isCurrentOwner(): Promise<boolean>
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
}

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
  private readonly channel: BroadcastChannel | null

  constructor(options?: { dbName?: string; tabId?: string }) {
    this.db = new NotebookOwnershipDatabase(options?.dbName)
    this.tabId = options?.tabId ?? getTabId()
    this.channel =
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel('runme-notebook-ownership')
        : null
    this.channel?.addEventListener('message', () => this.emit())
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
        .catch(async () => {
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
    this.listeners.clear()
    this.channel?.close()
    void this.db.close()
  }

  private createLease(record: NotebookOwnershipRecord): NotebookLease {
    return {
      notebookUri: record.notebookUri,
      tabId: record.ownerTabId,
      epoch: record.epoch,
      release: () => this.release(record.notebookUri),
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
    this.channel?.postMessage({ type, record })
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
