import { fromJson, toJson } from '@bufbuild/protobuf'
import type { Table } from 'dexie'

import { parseOperationLog, validateHeader } from '../lib/operationLog/codec'
import { unpackFrontier } from '../lib/operationLog/editorFrontier'
import type { ParsedOperationLog } from '../lib/operationLog/types'
import { parser_pb } from '../runme/client'
import { type JournalView, buildJournalView } from './journalView'
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
  view?: { format: 1; stamp: string; data: Blob }
}

/**
 * The owner's only route to OPFS. Invalidation commits before bytes change.
 * The durable generation outlives workers and also covers an initializing log
 * before its file record has acquired an operationLogRef.
 */
export class OwnedOperationLogs implements OperationLogStorage {
  readonly commits = new OwnerCommitQueue()
  // Keep at most one history resident. Requests for other notebooks can
  // evict it without affecting the durable current view or a pinned result.
  private history?: {
    path: string
    generation: number
    stamp: string
    parsed: ParsedOperationLog
  }

  private async parseCurrent(
    ref: OperationLogRef,
    generation: number,
    stamp: string
  ) {
    const cached = this.history
    if (
      cached?.path === ref.path &&
      cached.generation === generation &&
      cached.stamp === stamp
    )
      return cached.parsed
    const parsed = parseOperationLog((await this.storage.read(ref)).document)
    this.history = { path: ref.path, generation, stamp, parsed }
    return parsed
  }

  /** The read, generation check and publication share the OPFS writer queue. */
  readParsed(ref: OperationLogRef) {
    return this.commits.run(ref.path, async () =>
      this.parseCurrent(
        ref,
        await this.current(ref.path),
        (await this.storage.fileStamp?.(ref)) ?? ''
      )
    )
  }

  readView(ref: OperationLogRef): Promise<JournalView> {
    return this.commits.run(ref.path, async () => {
      const record = await this.generations.get(ref.path)
      const generation = record?.generation ?? 0
      const stamp = (await this.storage.fileStamp?.(ref)) ?? ''
      if (record?.view?.format === 1 && record.view.stamp === stamp) {
        try {
          const view = JSON.parse(await record.view.data.text())
          validateHeader(view.header)
          if (!Array.isArray(view.comments))
            throw new Error('Invalid cached comments')
          if (view.frontier) unpackFrontier(view.frontier)
          return {
            ...view,
            notebook: fromJson(parser_pb.NotebookSchema, view.notebook),
          }
        } catch {
          /* A damaged projection can always be rebuilt. */
        }
      }
      const view = buildJournalView(
        await this.parseCurrent(ref, generation, stamp)
      )
      try {
        const data = new Blob([
          JSON.stringify({
            ...view,
            notebook: toJson(parser_pb.NotebookSchema, view.notebook),
          }),
        ])
        await this.generations.put({
          path: ref.path,
          generation,
          view: { format: 1, stamp, data },
        })
      } catch {
        /* Quota or disabled Blob storage must not prevent an open. */
      }
      return view
    })
  }

  constructor(
    private readonly storage: OperationLogStorage,
    private readonly files: Table<LocalFileRecord, string>,
    private readonly generations: Table<ContentGeneration, string>,
    private readonly updateFile: (
      uri: string,
      changes: Partial<LocalFileRecord>
    ) => Promise<number> = (uri, changes) => files.update(uri, changes)
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
      if (this.history?.path === path) this.history = undefined
      let generation = 0
      await this.files.db.transaction(
        'rw',
        this.files,
        this.generations,
        async () => {
          generation = (await this.current(path)) + 1
          await this.generations.put({ path, generation })
          const uri = decodeURIComponent(path.split('/')[2] ?? '')
          await this.updateFile(uri, {
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
        await this.updateFile(uri, {
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
          await this.updateFile(uri, {
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
