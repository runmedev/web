import { create } from '@bufbuild/protobuf'

import { parser_pb } from '../../runme/client'
import { computeNotebookDiff } from '../notebookDiff/diff'
import type { RunmeOperation } from '../operationLog/types'
import type { CellCreatePayload } from '../operationLog/types'
import { type TrainingExample } from './model'
import { replayContent } from './payloads'
import type { ExamplePreview } from './protocol'
import { prepareRecordExample } from './recordInput'

/** The viewer renders the same sanitized input and replayed delta used by the
 * classifier, not today's notebook or the operations used to undo a suggestion.
 */
export function previewExample(
  _operations: RunmeOperation[],
  example: TrainingExample
): ExamplePreview {
  const input = prepareRecordExample(example)
  const notebook = (cells: CellCreatePayload[]) =>
    create(parser_pb.NotebookSchema, {
      cells: cells.map((cell) =>
        create(parser_pb.CellSchema, {
          refId: cell.cell_id,
          value: cell.cell.value,
          languageId: cell.cell.language_id,
          kind:
            cell.cell.kind === 'code'
              ? parser_pb.CellKind.CODE
              : parser_pb.CellKind.MARKUP,
        })
      ),
    })
  return {
    input,
    diff: computeNotebookDiff(
      notebook(input.initial),
      notebook(replayContent(input.initial, input.operations)),
      {
        includeMetadata: false,
        includeOutputs: false,
        matchCellIdsOnly: true,
      }
    ),
  }
}
