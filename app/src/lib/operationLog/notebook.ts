import { create, fromJson } from '@bufbuild/protobuf'

import { parser_pb } from '../../runme/client'
import { canonicalJson } from './canonicalJson'
import type { MaterializedOperationLog } from './materialize'
import type { JsonValue } from './types'

function stringValue(value: JsonValue): string {
  return typeof value === 'string' ? value : canonicalJson(value)
}

function stringRecord(
  values: Record<string, JsonValue>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, stringValue(value)])
  )
}

/** Adapt a materialized operation log to the editor's shared notebook model. */
export function materializedLogToNotebook(
  materialized: MaterializedOperationLog
): parser_pb.Notebook {
  const frontmatter = materialized.notebook.frontmatter
  const hasFrontmatter = Object.keys(frontmatter).length > 0
  return create(parser_pb.NotebookSchema, {
    metadata: stringRecord(materialized.notebook.metadata),
    frontmatter: hasFrontmatter
      ? fromJson(parser_pb.FrontmatterSchema, frontmatter)
      : undefined,
    cells: materialized.notebook.cells.map((cell) => {
      const result = cell.proto_json
        ? fromJson(parser_pb.CellSchema, cell.proto_json)
        : create(parser_pb.CellSchema)
      result.refId = cell.cell_id
      result.kind =
        cell.kind === 'code'
          ? parser_pb.CellKind.CODE
          : parser_pb.CellKind.MARKUP
      result.languageId = cell.language_id
      result.value = cell.value
      result.metadata = stringRecord(cell.metadata)
      result.outputs = cell.outputs.map((output) =>
        fromJson(parser_pb.CellOutputSchema, output)
      )
      return result
    }),
  })
}
