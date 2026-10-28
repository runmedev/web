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
import {
  captureCommittedRevision,
  snapshotHeads,
} from '../lib/operationLog/versions'
import { parser_pb } from '../runme/client'

/** Versioned, tab-local recovery contract. Operations retain their original IDs. */
export type EditorSaveCheckpoint = {
  format: 1
  uri: string
  actorId: string
  document: string
  baseline: string
  latest: string
  pending?: { operations: RunmeOperation[]; snapshot: string }
}

/** Page-owned save state survives replacing the storage connection. The worker
 * only commits immutable batches; it never owns this editor's save baseline.
 */
export class EditorSaveSession {
  readonly initialNotebook: parser_pb.Notebook
  private readonly notebookId: string
  private observed: RunmeOperation[]
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
    document: string,
    private readonly commit: (
      uri: string,
      notebookId: string,
      operations: RunmeOperation[]
    ) => Promise<void>,
    private readonly actorId = `editor:${crypto.randomUUID()}`,
    checkpoint?: EditorSaveCheckpoint,
    private onRecovered?: () => void
  ) {
    const parsed = parseOperationLog(upgradeOperationLogToV2(document))
    this.header = parsed.header
    this.notebookId = parsed.header.notebook_id
    this.observed = parsed.operations
    this.baseline = materializedLogToNotebook(
      materializeOperationLog(this.observed)
    )
    if (checkpoint) {
      if (
        checkpoint.format !== 1 ||
        checkpoint.uri !== uri ||
        checkpoint.actorId !== actorId
      )
        throw new Error('Unsupported or mismatched editor recovery checkpoint')
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
    return snapshotHeads(this.observed, captureCommittedRevision(this.observed))
  }

  /** Retry only the retained immutable batch, never regenerate an uncertain save. */
  private async commitPending(): Promise<void> {
    if (this.suspended)
      throw new Error('Editor saves paused for this tab’s reload')
    const pending = this.pending
    if (!pending) return
    await this.commit(this.uri, this.notebookId, pending.operations)
    this.observed = [...this.observed, ...pending.operations]
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
      format: 1,
      uri: this.uri,
      actorId: this.actorId,
      document: serializeOperationLog(this.header, this.observed),
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
          actorId: this.actorId,
          firstActorSequence:
            highestActorSequence(this.observed, this.actorId) + 1,
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
