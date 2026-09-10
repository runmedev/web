import { clone } from '@bufbuild/protobuf'

import { parser_pb } from '../runme/client'

export const RECOVERED_OUTPUT_KEY = 'runme.dev/recovered-output'

/** Identify diagnostics that explain saved corruption but are not execution results. */
export function isRecoveredOutput(output: parser_pb.CellOutput): boolean {
  return output.metadata?.[RECOVERED_OUTPUT_KEY] === 'true'
}

/** Export a copy without transient diagnostics; leave the editable model intact. */
export function withoutRecoveredOutputs(
  notebook: parser_pb.Notebook
): parser_pb.Notebook {
  const copy = clone(parser_pb.NotebookSchema, notebook)
  for (const cell of copy.cells)
    cell.outputs = cell.outputs.filter((output) => !isRecoveredOutput(output))
  return copy
}
