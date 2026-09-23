import type { Table } from 'dexie'

import type { LocalFileRecord } from './local'
import {
  type OperationLogAppendOptions,
  type OperationLogRef,
  type OperationLogSnapshot,
  type OperationLogStorage,
  operationLogPath,
} from './operationLogs'
import { OwnerCommitQueue } from './ownerCommitQueue'

export interface ContentGeneration {
  path: string
  generation: number
}

/**
 * The owner's only route to OPFS. Invalidation commits before bytes change.
 * The durable generation outlives workers and also covers an initializing log
 * before its file record has acquired an operationLogRef.
 */
export class OwnedOperationLogs implements OperationLogStorage {
  readonly commits = new OwnerCommitQueue()
  constructor(
    private readonly storage: OperationLogStorage,
    private readonly files: Table<LocalFileRecord, string>,
    private readonly generations: Table<ContentGeneration, string>
  ) {}

  supportsConcurrentWriters(): boolean {
    return true
  }

  private async current(path: string): Promise<number> {
    return (await this.generations.get(path))?.generation ?? 0
  }

  private async mutate(
    path: string,
    operation: () => Promise<OperationLogSnapshot | void>,
    initializingDocument?: string
  ) {
    return this.commits.run(path, async () => {
      let generation = 0
      await this.files.db.transaction(
        'rw',
        this.files,
        this.generations,
        async () => {
          generation = (await this.current(path)) + 1
          await this.generations.put({ path, generation })
          const uri = decodeURIComponent(path.split('/')[2] ?? '')
          await this.files.update(uri, {
            md5Checksum: '',
            operationLogRef: { storage: 'opfs', path },
            ...(initializingDocument === undefined
              ? {}
              : { pendingOperationLogInitialization: initializingDocument }),
          })
        }
      )
      const result = await operation()
      if (initializingDocument !== undefined) {
        const uri = decodeURIComponent(path.split('/')[2] ?? '')
        await this.files.update(uri, {
          pendingOperationLogInitialization: undefined,
        })
      }
      return result ? Object.assign(result, { generation }) : undefined
    })
  }

  initialize(uri: string, document: string): Promise<OperationLogSnapshot> {
    return this.mutate(
      operationLogPath(uri),
      () => this.storage.initialize(uri, document),
      document
    ) as Promise<OperationLogSnapshot>
  }
  read(ref: OperationLogRef): Promise<OperationLogSnapshot> {
    return this.commits.run(ref.path, async () => {
      const result = await this.storage.read(ref)
      return Object.assign(result, { generation: await this.current(ref.path) })
    })
  }
  append(
    ref: OperationLogRef,
    records: string,
    options?: OperationLogAppendOptions
  ): Promise<OperationLogSnapshot> {
    return this.mutate(ref.path, () =>
      this.storage.append(ref, records, options)
    ) as Promise<OperationLogSnapshot>
  }
  appendTransaction(
    ref: OperationLogRef,
    records: (document: string) => string | Promise<string>,
    options?: OperationLogAppendOptions
  ): Promise<OperationLogSnapshot> {
    return this.mutate(ref.path, () =>
      this.storage.appendTransaction(ref, records, options)
    ) as Promise<OperationLogSnapshot>
  }
  replace(
    ref: OperationLogRef,
    document: string,
    options?: { expectedChecksum?: string }
  ): Promise<OperationLogSnapshot> {
    return this.mutate(ref.path, () =>
      this.storage.replace(ref, document, options)
    ) as Promise<OperationLogSnapshot>
  }
  async delete(ref: OperationLogRef): Promise<void> {
    await this.mutate(ref.path, () => this.storage.delete(ref))
  }

  /** Network completion acknowledges its own snapshot, never a newer local edit. */
  async acknowledge(
    uri: string,
    snapshot: OperationLogSnapshot,
    remoteId: string,
    changes: Partial<LocalFileRecord>
  ): Promise<boolean> {
    return this.commits.run(snapshot.ref.path, () =>
      this.files.db.transaction(
        'rw',
        this.files,
        this.generations,
        async () => {
          const file = await this.files.get(uri)
          if (
            !file ||
            file.remoteId !== remoteId ||
            file.operationLogRef?.path !== snapshot.ref.path
          )
            return false
          const current =
            (await this.current(snapshot.ref.path)) === snapshot.generation
          await this.files.update(uri, {
            ...changes,
            lastRemoteChecksum: snapshot.checksum,
            md5Checksum: current ? snapshot.checksum : '',
            ...(current
              ? {}
              : { lastSyncError: file.lastSyncError, conflict: file.conflict }),
          })
          return current
        }
      )
    )
  }
}
