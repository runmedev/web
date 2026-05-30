import { fromJsonString } from '@bufbuild/protobuf'

import { parser_pb } from '../../runme/client'
import type { LocalNotebooks } from '../../storage/local'
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

  const upstreamNotebook = parseNotebookJson(
    record.conflict.upstreamDoc,
    'upstream'
  )
  const localNotebook = parseNotebookJson(record.doc ?? '', 'local')
  const document = registerNotebookDiffDocument({
    id: `conflict-${encodeURIComponent(localUri)}`,
    base: {
      label: 'Upstream version',
      revisionId: record.conflict.upstreamVersion?.revisionId,
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
  openNotebookDiffDocument(document)
}
