import { clone, fromJsonString } from '@bufbuild/protobuf'

import { RunmeMetadataKey, parser_pb } from '../../runme/client'
import type {
  LocalFileRecord,
  LocalNotebooks,
  NotebookConflictState,
  UpstreamVersion,
} from '../../storage/local'
import { computeNotebookDiff } from './diff'
import type { CellDiff, NotebookDiffDocument } from './model'
import {
  openNotebookDiffDocument,
  registerNotebookDiffDocument,
} from './registry'

export interface ConflictCellMutationResult {
  document: NotebookDiffDocument
  localNotebook: parser_pb.Notebook
}

export type RestoredConflictCellResult = ConflictCellMutationResult

export interface ConflictCellMutationOptions {
  localNotebook?: parser_pb.Notebook
}

export type RestoreDeletedConflictCellOptions = ConflictCellMutationOptions
export type RemoveInsertedConflictCellOptions = ConflictCellMutationOptions

type DriveDiffResolutionKind = NonNullable<
  NotebookDiffDocument['resolution']
>['kind']

function diffDocumentIdForResolution(
  localUri: string,
  resolutionKind: DriveDiffResolutionKind
): string {
  const prefix =
    resolutionKind === 'notebook-sync-conflict'
      ? 'conflict'
      : resolutionKind
  return `${prefix}-${encodeURIComponent(localUri)}`
}

function parseNotebookJson(
  serialized: string,
  label: string
): parser_pb.Notebook {
  try {
    return fromJsonString(parser_pb.NotebookSchema, serialized || '{}', {
      ignoreUnknownFields: true,
    })
  } catch (error) {
    throw new Error(
      `Unable to parse ${label} notebook for conflict diff: ${String(error)}`
    )
  }
}

async function registerConflictDiffDocument(
  store: LocalNotebooks,
  localUri: string,
  record: LocalFileRecord,
  conflict: NotebookConflictState
): Promise<NotebookDiffDocument> {
  const upstreamDoc = await store.getConflictUpstreamDoc(localUri)
  const upstreamNotebook = parseNotebookJson(upstreamDoc, 'upstream')
  const localNotebook = parseNotebookJson(record.doc ?? '', 'local')
  return registerNotebookDiffDocument({
    id: diffDocumentIdForResolution(localUri, 'notebook-sync-conflict'),
    base: {
      label: 'Upstream version',
      revisionId: conflict.upstreamVersion?.revisionId,
    },
    compare: {
      label: 'Local version',
    },
    diff: computeNotebookDiff(upstreamNotebook, localNotebook, {
      includeOutputs: true,
      includeMetadata: true,
    }),
    resolution: {
      kind: 'notebook-sync-conflict',
      localUri,
    },
  })
}

export async function loadNotebookConflictDiffDocument(
  store: LocalNotebooks,
  localUri: string
): Promise<NotebookDiffDocument> {
  const record = await store.files.get(localUri)
  if (!record) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }
  if (!record.conflict) {
    throw new Error(`Local notebook ${localUri} does not have a conflict`)
  }

  return registerConflictDiffDocument(store, localUri, record, record.conflict)
}

async function registerUpstreamDiffDocument(
  localUri: string,
  record: LocalFileRecord,
  upstreamDoc: string,
  upstreamVersion: UpstreamVersion | undefined,
  resolutionKind: DriveDiffResolutionKind = 'drive-upstream-diff'
): Promise<NotebookDiffDocument> {
  const upstreamNotebook = parseNotebookJson(upstreamDoc, 'upstream')
  const localNotebook = parseNotebookJson(record.doc ?? '', 'local')
  return registerNotebookDiffDocument({
    id: diffDocumentIdForResolution(localUri, resolutionKind),
    base: {
      label: 'Upstream version',
      revisionId: upstreamVersion?.revisionId,
    },
    compare: {
      label: 'Local version',
    },
    diff: computeNotebookDiff(upstreamNotebook, localNotebook, {
      includeOutputs: true,
      includeMetadata: true,
    }),
    resolution: {
      kind: resolutionKind,
      localUri,
      upstreamRevisionId:
        resolutionKind === 'drive-upstream-diff'
          ? upstreamVersion?.revisionId
          : undefined,
    },
  })
}

async function registerDriveRevisionDiffDocument(
  store: LocalNotebooks,
  localUri: string,
  revisionId: string,
  resolutionKind: DriveDiffResolutionKind = 'notebook-sync-conflict',
  currentUpstreamRevisionId?: string
): Promise<NotebookDiffDocument> {
  const normalizedRevisionId = revisionId.trim()
  if (!normalizedRevisionId) {
    throw new Error('Drive revision diff requires a revision id')
  }

  const record = await store.files.get(localUri)
  if (!record) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }

  if (
    resolutionKind === 'drive-upstream-diff' &&
    currentUpstreamRevisionId === normalizedRevisionId
  ) {
    const upstream = await store.getDriveUpstreamDoc(localUri)
    if (upstream.version?.revisionId === normalizedRevisionId) {
      return registerUpstreamDiffDocument(
        localUri,
        record,
        upstream.doc,
        upstream.version,
        resolutionKind
      )
    }
  }

  if (record.conflict?.upstreamVersion?.revisionId === normalizedRevisionId) {
    return registerConflictDiffDocument(store, localUri, record, record.conflict)
  }

  const revisionDoc = await store.getDriveRevisionDoc(
    localUri,
    normalizedRevisionId
  )
  const revisionNotebook = parseNotebookJson(
    revisionDoc,
    `Drive revision ${normalizedRevisionId}`
  )
  const localNotebook = parseNotebookJson(record.doc ?? '', 'local')
  return registerNotebookDiffDocument({
    id: diffDocumentIdForResolution(localUri, resolutionKind),
    base: {
      label: `Drive revision ${normalizedRevisionId}`,
      revisionId: normalizedRevisionId,
    },
    compare: {
      label: 'Local version',
    },
    diff: computeNotebookDiff(revisionNotebook, localNotebook, {
      includeOutputs: true,
      includeMetadata: true,
    }),
    resolution: {
      kind: resolutionKind,
      localUri,
      upstreamRevisionId:
        resolutionKind === 'drive-upstream-diff'
          ? currentUpstreamRevisionId
          : undefined,
    },
  })
}

function findRestoredCellIndex(
  upstreamNotebook: parser_pb.Notebook,
  localNotebook: parser_pb.Notebook,
  restoredCell: parser_pb.Cell,
  baseIndex: number
): number {
  const localCells = localNotebook.cells ?? []
  const upstreamCells = upstreamNotebook.cells ?? []

  for (let index = baseIndex - 1; index >= 0; index -= 1) {
    const refId = upstreamCells[index]?.refId
    const localIndex = refId
      ? localCells.findIndex((cell) => cell.refId === refId)
      : -1
    if (localIndex >= 0) {
      return localIndex + 1
    }
  }

  for (let index = baseIndex + 1; index < upstreamCells.length; index += 1) {
    const refId = upstreamCells[index]?.refId
    const localIndex = refId
      ? localCells.findIndex((cell) => cell.refId === refId)
      : -1
    if (localIndex >= 0) {
      return localIndex
    }
  }

  const createdAt = restoredCell.metadata?.[RunmeMetadataKey.CreatedAt]
  const restoredTime = createdAt ? Date.parse(createdAt) : Number.NaN
  if (!Number.isNaN(restoredTime)) {
    const timestampIndex = localCells.findIndex((cell) => {
      const localCreatedAt = cell.metadata?.[RunmeMetadataKey.CreatedAt]
      const localTime = localCreatedAt ? Date.parse(localCreatedAt) : Number.NaN
      return !Number.isNaN(localTime) && localTime > restoredTime
    })
    if (timestampIndex >= 0) {
      return timestampIndex
    }
  }

  return Math.min(Math.max(baseIndex, 0), localCells.length)
}

export async function restoreDeletedConflictCell(
  store: LocalNotebooks,
  localUri: string,
  row: CellDiff,
  options: RestoreDeletedConflictCellOptions = {}
): Promise<RestoredConflictCellResult> {
  if (row.kind !== 'deleted' || !row.baseCell) {
    throw new Error('Only deleted upstream cells can be restored.')
  }

  const record = await store.files.get(localUri)
  if (!record) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }
  if (!record.conflict) {
    throw new Error(`Local notebook ${localUri} does not have a conflict`)
  }

  const upstreamDoc = await store.getConflictUpstreamDoc(localUri)
  const upstreamNotebook = parseNotebookJson(upstreamDoc, 'upstream')
  const localNotebook = options.localNotebook
    ? clone(parser_pb.NotebookSchema, options.localNotebook)
    : parseNotebookJson(record.doc ?? '', 'local')
  const localCells = localNotebook.cells ?? []
  const refId = row.baseCell.refId
  if (refId && localCells.some((cell) => cell.refId === refId)) {
    if (options.localNotebook) {
      await store.save(localUri, localNotebook)
      const updatedRecord = await store.files.get(localUri)
      if (!updatedRecord) {
        throw new Error(`Local notebook record not found for ${localUri}`)
      }
      return {
        document: await registerConflictDiffDocument(
          store,
          localUri,
          updatedRecord,
          record.conflict
        ),
        localNotebook,
      }
    }
    return {
      document: await registerConflictDiffDocument(
        store,
        localUri,
        record,
        record.conflict
      ),
      localNotebook,
    }
  }

  const restoredCell = clone(parser_pb.CellSchema, row.baseCell)
  const now = new Date().toISOString()
  restoredCell.metadata ??= {}
  restoredCell.metadata[RunmeMetadataKey.CreatedAt] ??= now
  restoredCell.metadata[RunmeMetadataKey.UpdatedAt] = now

  const insertIndex = findRestoredCellIndex(
    upstreamNotebook,
    localNotebook,
    restoredCell,
    row.baseIndex ?? localCells.length
  )
  localNotebook.cells.splice(insertIndex, 0, restoredCell)

  await store.save(localUri, localNotebook)

  const updatedRecord = await store.files.get(localUri)
  if (!updatedRecord) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }
  return {
    document: await registerConflictDiffDocument(
      store,
      localUri,
      updatedRecord,
      record.conflict
    ),
    localNotebook,
  }
}

function findInsertedCellIndex(
  localNotebook: parser_pb.Notebook,
  row: CellDiff
): number {
  const localCells = localNotebook.cells ?? []
  const refId = row.compareCell?.refId
  if (refId) {
    const matchingIndexes = localCells.flatMap((cell, index) =>
      cell.refId === refId ? [index] : []
    )
    if (matchingIndexes.length === 1) {
      return matchingIndexes[0]
    }
    if (matchingIndexes.length > 1) {
      throw new Error(`Local notebook has duplicate cell refId ${refId}.`)
    }
    throw new Error(`Local cell ${refId} is no longer present.`)
  }

  const compareCell = row.compareCell
  const compareIndex = row.compareIndex
  if (compareCell && compareIndex !== undefined) {
    const candidate = localCells[compareIndex]
    if (
      candidate &&
      !candidate.refId &&
      candidate.kind === compareCell.kind &&
      candidate.languageId === compareCell.languageId &&
      candidate.value === compareCell.value
    ) {
      return compareIndex
    }
  }

  throw new Error('Local cell is no longer present at the expected position.')
}

export async function removeInsertedConflictCell(
  store: LocalNotebooks,
  localUri: string,
  row: CellDiff,
  options: RemoveInsertedConflictCellOptions = {}
): Promise<ConflictCellMutationResult> {
  if (row.kind !== 'inserted' || !row.compareCell) {
    throw new Error(
      'Only cells present exclusively in the local notebook can be removed.'
    )
  }

  const record = await store.files.get(localUri)
  if (!record) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }
  if (!record.conflict) {
    throw new Error(`Local notebook ${localUri} does not have a conflict`)
  }

  const localNotebook = options.localNotebook
    ? clone(parser_pb.NotebookSchema, options.localNotebook)
    : parseNotebookJson(record.doc ?? '', 'local')
  const removeIndex = findInsertedCellIndex(localNotebook, row)
  localNotebook.cells.splice(removeIndex, 1)

  await store.save(localUri, localNotebook)

  const updatedRecord = await store.files.get(localUri)
  if (!updatedRecord) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }
  return {
    document: await registerConflictDiffDocument(
      store,
      localUri,
      updatedRecord,
      record.conflict
    ),
    localNotebook,
  }
}

export async function openNotebookConflictDiff(
  store: LocalNotebooks,
  localUri: string
): Promise<void> {
  const document = await loadNotebookConflictDiffDocument(store, localUri)
  openNotebookDiffDocument(document)
}

export async function openNotebookUpstreamDiff(
  store: LocalNotebooks,
  localUri: string
): Promise<void> {
  const record = await store.files.get(localUri)
  if (!record) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }

  if (record.conflict) {
    const document = await registerConflictDiffDocument(
      store,
      localUri,
      record,
      record.conflict
    )
    openNotebookDiffDocument(document)
    return
  }

  const upstream = await store.getDriveUpstreamDoc(localUri)
  const document = await registerUpstreamDiffDocument(
    localUri,
    record,
    upstream.doc,
    upstream.version,
    'drive-upstream-diff'
  )
  openNotebookDiffDocument(document)
}

export async function openNotebookDriveRevisionDiff(
  store: LocalNotebooks,
  localUri: string,
  revisionId: string,
  options: {
    resolutionKind?: DriveDiffResolutionKind
    currentUpstreamRevisionId?: string
  } = {}
): Promise<void> {
  const document = await registerDriveRevisionDiffDocument(
    store,
    localUri,
    revisionId,
    options.resolutionKind ?? 'notebook-sync-conflict',
    options.currentUpstreamRevisionId
  )
  openNotebookDiffDocument(document)
}

export async function refreshNotebookConflictDiff(
  store: LocalNotebooks,
  localUri: string
): Promise<void> {
  const conflict = await store.refreshConflictWithLatestUpstream(localUri)
  const record = await store.files.get(localUri)
  if (!record) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }

  await registerConflictDiffDocument(store, localUri, record, conflict)
}
