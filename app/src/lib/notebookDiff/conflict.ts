import { fromJsonString } from '@bufbuild/protobuf'

import { parser_pb } from '../../runme/client'
import type {
  LocalFileRecord,
  LocalNotebooks,
  NotebookConflictState,
} from '../../storage/local'
import { computeNotebookDiff } from './diff'
import {
  openNotebookDiffDocument,
  registerNotebookDiffDocument,
} from './registry'

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

function registerConflictDiffDocument(
  localUri: string,
  record: LocalFileRecord,
  conflict: NotebookConflictState
) {
  const upstreamNotebook = parseNotebookJson(conflict.upstreamDoc, 'upstream')
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

export async function openNotebookConflictDiff(
  store: LocalNotebooks,
  localUri: string
): Promise<void> {
  const record = await store.files.get(localUri)
  if (!record) {
    throw new Error(`Local notebook record not found for ${localUri}`)
  }
  if (!record.conflict) {
    throw new Error(`Local notebook ${localUri} does not have a conflict`)
  }

  const document = registerConflictDiffDocument(
    localUri,
    record,
    record.conflict
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

  registerConflictDiffDocument(localUri, record, conflict)
}
