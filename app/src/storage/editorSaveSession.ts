import { fromJsonString, toJsonString } from '@bufbuild/protobuf'

import {
  type RunmeOperation,
  buildOperationLogDiff,
  cloneNotebook,
  highestActorSequence,
  materializeOperationLog,
  materializedLogToNotebook,
  parseOperationLog,
  serializeOperationLog,
  upgradeOperationLogToV2,
} from '../lib/operationLog'
import { validateHeader, validateOperation } from '../lib/operationLog/codec'
import {
  type EditorFrontier,
  type PackedFrontier,
  advanceEditorFrontier,
  packFrontier,
  unpackFrontier,
} from '../lib/operationLog/editorFrontier'
import type { NotebookLogHeader } from '../lib/operationLog/types'
import {
  captureCommittedRevision,
  snapshotHeads,
} from '../lib/operationLog/versions'
import { parser_pb } from '../runme/client'
import type { JournalView } from './journalView'

/** Versioned, tab-local recovery contract. Operations retain their original IDs. */
export type EditorSaveCheckpoint = {
  uri: string
  actorId: string
  baseline: string
  latest: string
  pending?: { operations: RunmeOperation[]; snapshot: string }
} & (
  | { format: 1; document: string }
  | {
      format: 2
      document?: never
      header: NotebookLogHeader
      frontier: PackedFrontier
    }
)

/** Page-owned save state survives replacing the storage connection. The worker
 * only commits immutable batches; it never owns this editor's save baseline.
 */
export class EditorSaveSession {
  readonly initialNotebook: parser_pb.Notebook
  private readonly notebookId: string
  private frontier?: EditorFrontier
  private observed: RunmeOperation[] = []
  private baseline: parser_pb.Notebook
  private pending?: {
    operations: RunmeOperation[]
    snapshot: parser_pb.Notebook
  }
  private queue = Promise.resolve()
  private saving = 0
  private suspended = false
  private latest: parser_pb.Notebook
  private readonly header: ReturnType<typeof parseOperationLog>['header']

  /** Pending work blocks an app reload, but never prevents stopping the worker. */
  get hasPending(): boolean {
    return Boolean(this.pending) || this.saving > 0
  }

  constructor(
    private readonly uri: string,
    document: string | JournalView | undefined,
    private readonly commit: (
      uri: string,
      notebookId: string,
      operations: RunmeOperation[]
    ) => Promise<void>,
    private readonly actorId = `editor:${crypto.randomUUID()}`,
    checkpoint?: EditorSaveCheckpoint,
    private onRecovered?: () => void
  ) {
    if (checkpoint?.format === 2) {
      this.header = validateHeader(checkpoint.header)
      this.frontier = unpackFrontier(checkpoint.frontier)
      this.baseline = fromJsonString(
        parser_pb.NotebookSchema,
        checkpoint.baseline
      )
    } else if (typeof document === 'object' && document.frontier) {
      this.header = { ...validateHeader(document.header), format_version: 2 }
      this.frontier = unpackFrontier(document.frontier)
      this.baseline = cloneNotebook(document.notebook)
    } else {
      if (typeof document !== 'string')
        throw new Error('Missing editor recovery document')
      const parsed = parseOperationLog(upgradeOperationLogToV2(document))
      this.header = parsed.header
      this.observed = parsed.operations
      this.baseline = materializedLogToNotebook(
        materializeOperationLog(this.observed)
      )
    }
    this.notebookId = this.header.notebook_id
    if (checkpoint) {
      if (
        (checkpoint.format !== 1 && checkpoint.format !== 2) ||
        checkpoint.uri !== uri ||
        checkpoint.actorId !== actorId
      )
        throw new Error('Unsupported or mismatched editor recovery checkpoint')
      if (checkpoint.format === 1)
        this.baseline = fromJsonString(
          parser_pb.NotebookSchema,
          checkpoint.baseline
        )
      this.pending = checkpoint.pending && {
        operations: structuredClone(checkpoint.pending.operations),
        snapshot: fromJsonString(
          parser_pb.NotebookSchema,
          checkpoint.pending.snapshot
        ),
      }
      // Parse the combined history before replaying anything. Corrupt checkpoints
      // remain in session storage; never turn them into an empty editor.
      if (this.frontier) {
        let clock = this.frontier.lamport
        let seq = this.frontier.sequences.get(actorId) ?? 0
        let deps = this.frontier.heads
        for (const op of this.pending?.operations ?? []) {
          validateOperation(op)
          if (
            op.actor_id !== actorId ||
            op.actor_seq !== ++seq ||
            op.op_id !== actorId + ':' + seq ||
            op.lamport !== ++clock ||
            JSON.stringify(op.deps) !== JSON.stringify(deps)
          )
            throw new Error('Invalid recovery operation frontier')
          deps = [op.op_id]
        }
      } else
        parseOperationLog(
          serializeOperationLog(this.header, [
            ...this.observed,
            ...(this.pending?.operations ?? []),
          ])
        )
    }
    this.latest = checkpoint
      ? fromJsonString(parser_pb.NotebookSchema, checkpoint.latest)
      : cloneNotebook(this.baseline)
    this.initialNotebook = cloneNotebook(this.latest)
  }

  /** Only acknowledged history participates in release handoff verification. */
  getObservedOperationHeads(): string[] {
    if (this.frontier) return [...this.frontier.heads].sort()
    return snapshotHeads(this.observed, captureCommittedRevision(this.observed))
  }

  /** Retry only the retained immutable batch, never regenerate an uncertain save. */
  private async commitPending(): Promise<void> {
    if (this.suspended)
      throw new Error('Editor saves paused for this tab’s reload')
    const pending = this.pending
    if (!pending) return
    await this.commit(this.uri, this.notebookId, pending.operations)
    if (this.frontier) advanceEditorFrontier(this.frontier, pending.operations)
    else this.observed = [...this.observed, ...pending.operations]
    this.baseline = pending.snapshot
    this.pending = undefined
  }

  /** The caller disconnects transport first so a missing reply cannot block a
   * checkpoint. Await local diff generation, never worker persistence.
   */
  async checkpoint(latest?: parser_pb.Notebook): Promise<EditorSaveCheckpoint> {
    this.suspended = true
    await this.queue
    return {
      ...(this.frontier
        ? {
            format: 2 as const,
            header: this.header,
            frontier: packFrontier(this.frontier),
          }
        : {
            format: 1 as const,
            document: serializeOperationLog(this.header, this.observed),
          }),
      uri: this.uri,
      actorId: this.actorId,
      baseline: toJsonString(parser_pb.NotebookSchema, this.baseline),
      latest: toJsonString(parser_pb.NotebookSchema, latest ?? this.latest),
      pending: this.pending && {
        operations: structuredClone(this.pending.operations),
        snapshot: toJsonString(parser_pb.NotebookSchema, this.pending.snapshot),
      },
    }
  }

  /** Failed backup leaves this editor usable with its original pending batch. */
  resumeAfterFailedCheckpoint(): void {
    this.suspended = false
  }

  getUri(): string {
    return this.uri
  }

  /** Replay the original batch first, then save later typing retained in the
   * snapshot. A failed replay may have prevented that snapshot's diff entirely.
   */
  resume(): Promise<void> {
    return this.save(this.uri, this.latest)
  }

  /** Capture at call time: keystrokes during an acknowledgement wait belong to
   * the next save. Serializing also prevents overlapping actor sequence ranges.
   */
  save(saveUri: string, notebook: parser_pb.Notebook): Promise<void> {
    if (saveUri !== this.uri)
      return Promise.reject(
        new Error(
          `Operation-log save URI changed from ${this.uri} to ${saveUri}`
        )
      )
    const next = cloneNotebook(notebook)
    this.latest = next
    this.saving += 1
    const operation = this.queue
      .then(async () => {
        await this.commitPending()
        const operations = await buildOperationLogDiff({
          previous: this.baseline,
          next,
          observedOperations: this.observed,
          frontier: this.frontier,
          actorId: this.actorId,
          firstActorSequence:
            (this.frontier?.sequences.get(this.actorId) ??
              highestActorSequence(this.observed, this.actorId)) + 1,
        })
        if (!operations.length) {
          this.baseline = next
          return
        }
        this.pending = { operations, snapshot: next }
        await this.commitPending()
      })
      .then(() => {
        // A checkpoint is consumed only after its full editor state is durable,
        // including when the initial replay failed and reconnect completed it.
        this.onRecovered?.()
        this.onRecovered = undefined
      })
      .finally(() => {
        this.saving -= 1
      })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
