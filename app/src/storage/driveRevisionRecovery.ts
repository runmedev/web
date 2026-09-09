import md5 from 'md5'

import { parseDriveItem } from './drive'
import type {
  DriveNotebookStore,
  DriveRevision,
  DriveVersionMetadata,
} from './drive'

/** IDs are opaque. Persist sets rather than inferring order or version increments. */
export interface DriveRecoveryCheckpoint {
  fileId: string
  knownRevisionIds: string[]
  pendingRevisionIds: string[]
  /** The observed head must remain available while an upload is reconciled. */
  anchorRevisionId: string
}

interface Snapshot {
  content: string
  version: DriveVersionMetadata | null
}

/**
 * Tracks revisions whose operations have reached the durable local journal.
 * The checkpoint is written before uploads/downloads and acknowledged only
 * after OPFS append completes, so reloads and unknown upload outcomes retry
 * recovery without forgetting overwritten collaborator revisions.
 */
export class DriveRevisionRecovery {
  constructor(
    private readonly drive: Pick<
      DriveNotebookStore,
      'getVersionMetadata' | 'listRevisions' | 'loadRevisionForRecovery'
    >,
    private readonly uri: string,
    private checkpoint: DriveRecoveryCheckpoint | undefined,
    private readonly persist: (
      checkpoint: DriveRecoveryCheckpoint
    ) => Promise<void>
  ) {
    if (checkpoint?.fileId !== parseDriveItem(uri).id)
      this.checkpoint = undefined
  }

  /** Establish the history boundary before the first sync attempt reads media. */
  async initialize(): Promise<boolean> {
    if (this.checkpoint) return true
    const before = await this.drive.getVersionMetadata(this.uri)
    const revisions = await this.drive.listRevisions(this.uri)
    const after = await this.drive.getVersionMetadata(this.uri)
    const head = after?.headRevisionId
    if (!head)
      throw new Error(
        'Drive recovery requires a head revision ID; local operations remain pending.'
      )
    if (before?.headRevisionId !== head || before?.version !== after?.version)
      return false
    this.requireRevisions(revisions, [head])
    // Older history predates this replica's recovery boundary. The current
    // head is deliberately excluded: it must be read even if overwritten next.
    await this.save({
      fileId: parseDriveItem(this.uri).id,
      knownRevisionIds: revisions.flatMap((revision) =>
        revision.id && revision.id !== head ? [revision.id] : []
      ),
      pendingRevisionIds: [head],
      anchorRevisionId: head,
    })
    return true
  }

  /** Discover every page, including intervening writes hidden behind our head. */
  async collect(
    snapshot: Snapshot
  ): Promise<{ revisions: DriveRevision[]; contents: string[] }> {
    if (!this.checkpoint)
      throw new Error('Drive revision recovery is not initialized')
    const revisions = await this.drive.listRevisions(this.uri)
    const head = snapshot.version?.headRevisionId
    if (!head)
      throw new Error(
        'Drive recovery requires a head revision ID; local operations remain pending.'
      )
    this.requireRevisions(revisions, [
      this.checkpoint.anchorRevisionId,
      ...this.checkpoint.pendingRevisionIds,
      head,
    ])
    const known = new Set(this.checkpoint.knownRevisionIds)
    const pending = revisions.filter(
      (revision) => revision.id && !known.has(revision.id)
    )
    await this.save({
      ...this.checkpoint,
      pendingRevisionIds: pending.map((revision) => revision.id!),
    })
    const contents: string[] = []
    for (const revision of pending) {
      const content =
        revision.id === head
          ? snapshot.content
          : await this.drive.loadRevisionForRecovery(this.uri, revision)
      if (revision.md5Checksum && md5(content) !== revision.md5Checksum) {
        throw new Error(
          `Drive recovery checksum mismatch for revision ${revision.id}; local operations remain pending.`
        )
      }
      // Zero-byte creation revisions have no operations to recover.
      if (content !== '') contents.push(content)
    }
    return { revisions, contents }
  }

  /** Call only after every collected operation has been appended to OPFS. */
  async acknowledge(revisions: DriveRevision[], head: string): Promise<void> {
    await this.save({
      fileId: parseDriveItem(this.uri).id,
      knownRevisionIds: revisions.flatMap((revision) =>
        revision.id ? [revision.id] : []
      ),
      pendingRevisionIds: [],
      anchorRevisionId: head,
    })
  }

  /** An upload receipt identifies our write; a later metadata read does not. */
  async uploaded(receipt: DriveVersionMetadata): Promise<void> {
    if (!this.checkpoint || !receipt.headRevisionId) return
    await this.save({
      ...this.checkpoint,
      knownRevisionIds: [
        ...new Set([
          ...this.checkpoint.knownRevisionIds,
          receipt.headRevisionId,
        ]),
      ],
      // Keep the pre-upload anchor until history has been inspected again.
    })
  }

  private requireRevisions(
    revisions: DriveRevision[],
    required: string[]
  ): void {
    const available = new Set(revisions.map((revision) => revision.id))
    const missing = required.find((id) => !available.has(id))
    if (missing)
      throw new Error(
        `Drive revision ${missing} is no longer available for recovery. Local operations remain pending; restore the missing history or reconcile a saved copy.`
      )
  }

  private async save(checkpoint: DriveRecoveryCheckpoint): Promise<void> {
    await this.persist(checkpoint)
    this.checkpoint = checkpoint
  }
}
