import { clone, fromJsonString } from '@bufbuild/protobuf'

import { RunmeMetadataKey, parser_pb } from '../../runme/client'
import type {
  LocalFileRecord,
  LocalNotebooks,
  NotebookConflictState,
} from '../../storage/local'
import { computeNotebookDiff } from './diff'
import type { CellDiff, NotebookDiffDocument } from './model'
import {
  openNotebookDiffDocument,
  registerNotebookDiffDocument,
} from './registry'

export interface RestoredConflictCellResult {
  document: NotebookDiffDocument
  localNotebook: parser_pb.Notebook
}

export interface RestoreDeletedConflictCellOptions {
  localNotebook?: parser_pb.Notebook
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
    id: `conflict-${encodeURIComponent(localUri)}`,
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

export async function openNotebookConflictDiff(
  store: LocalNotebooks,
  localUri: string
): Promise<void> {
  const document = await loadNotebookConflictDiffDocument(store, localUri)
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
