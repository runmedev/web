import {
  type RunmeOperation,
  buildOperationLogDiff,
  cloneNotebook,
  highestActorSequence,
  materializeOperationLog,
  materializedLogToNotebook,
  parseOperationLog,
} from '../lib/operationLog'
import {
  captureCommittedRevision,
  snapshotHeads,
} from '../lib/operationLog/versions'
import type { parser_pb } from '../runme/client'

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
    private readonly actorId = `editor:${crypto.randomUUID()}`
  ) {
    const parsed = parseOperationLog(document)
    this.notebookId = parsed.header.notebook_id
    this.observed = parsed.operations
    this.baseline = materializedLogToNotebook(
      materializeOperationLog(this.observed)
    )
    this.initialNotebook = cloneNotebook(this.baseline)
  }

  /** Only acknowledged history participates in release handoff verification. */
  getObservedOperationHeads(): string[] {
    return snapshotHeads(this.observed, captureCommittedRevision(this.observed))
  }

  /** Retry only the retained immutable batch, never regenerate an uncertain save. */
  private async commitPending(): Promise<void> {
    const pending = this.pending
    if (!pending) return
    await this.commit(this.uri, this.notebookId, pending.operations)
    this.observed = [...this.observed, ...pending.operations]
    this.baseline = pending.snapshot
    this.pending = undefined
  }

  /** Reconnect can finish a pending save without replacing the mounted model. */
  resume(): Promise<void> {
    const operation = this.queue.then(() => this.commitPending())
    this.queue = operation.catch(() => undefined)
    return operation
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
      .finally(() => {
        this.saving -= 1
      })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
