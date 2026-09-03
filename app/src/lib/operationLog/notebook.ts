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
      ? create(parser_pb.FrontmatterSchema, {
          shell: typeof frontmatter.shell === 'string' ? frontmatter.shell : '',
          cwd: typeof frontmatter.cwd === 'string' ? frontmatter.cwd : '',
          skipPrompts:
            typeof frontmatter.skip_prompts === 'boolean'
              ? frontmatter.skip_prompts
              : false,
          category:
            typeof frontmatter.category === 'string'
              ? frontmatter.category
              : '',
          terminalRows:
            typeof frontmatter.terminal_rows === 'string'
              ? frontmatter.terminal_rows
              : '',
          tag: typeof frontmatter.tag === 'string' ? frontmatter.tag : '',
        })
      : undefined,
    cells: materialized.notebook.cells.map((cell) =>
      create(parser_pb.CellSchema, {
        refId: cell.cell_id,
        kind:
          cell.kind === 'code'
            ? parser_pb.CellKind.CODE
            : parser_pb.CellKind.MARKUP,
        languageId: cell.language_id,
        value: cell.value,
        metadata: stringRecord(cell.metadata),
        outputs: cell.outputs.map((output) =>
          fromJson(parser_pb.CellOutputSchema, output)
        ),
      })
    ),
  })
}
