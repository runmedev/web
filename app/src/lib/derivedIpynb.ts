import { clone } from '@bufbuild/protobuf'

import { parser_pb } from '../runme/client'
import {
  AUTO_IPYNB_KEY,
  DERIVED_NOTEBOOK_KEY,
  type DerivedNotebookSource,
} from './derivedNotebook'
import { type IpynbNotebook, encodeIpynb } from './ipynb'

/** Export a full materialized snapshot with a notice visible in Colab too. */
export function encodeDerivedIpynb(
  notebook: parser_pb.Notebook,
  source: DerivedNotebookSource
): string {
  const copy = clone(parser_pb.NotebookSchema, notebook)
  delete copy.metadata[AUTO_IPYNB_KEY]
  copy.metadata[DERIVED_NOTEBOOK_KEY] = JSON.stringify(source)
  const result = JSON.parse(encodeIpynb(copy).text) as IpynbNotebook
  result.metadata.runme = {
    ...(result.metadata.runme as object),
    derivedFrom: source,
  }
  let noticeId = 'runme-derived-notice'
  while (result.cells.some((cell) => cell.id === noticeId)) noticeId += '-copy'
  result.cells.unshift({
    cell_type: 'markdown',
    id: noticeId,
    metadata: {},
    source: `> **Generated notebook — treat as read-only.** This is a derived copy of a [.runme notebook](${source.uri}). It will be overwritten on the next source save while automatic export is enabled. Make durable changes in the source notebook.`,
  })
  return `${JSON.stringify(result, null, 2)}\n`
}
