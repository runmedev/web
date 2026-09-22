import { fromJson } from '@bufbuild/protobuf'

import { parser_pb } from '../runme/client'
import { materializeOperationLog } from './operationLog/materialize'
import type { VersionRef } from './operationLog/records'
import type { CellUpdatePayload, RunmeOperation } from './operationLog/types'
import { ancestorClosure, resolveVersion } from './operationLog/versions'

export const OUTPUT_REFERENCE_LANGUAGE = 'runme-reference'
export const OUTPUT_REFERENCE_EXPORT_MESSAGE =
  'Versioned references to other cells or outputs are not supported in .ipynb files. Open the original .runme notebook to view this result.'

export interface OutputReference {
  cellId: string
  version: VersionRef
  outputIndex: number
  itemIndex: number
}

export interface ResolvedOutputReference {
  item: parser_pb.CellOutputItem
  executionId: string
  status: string
  source?: string
  sourceOperationId?: string
  language: string
  provenanceError?: string
}

/** A logical content cell; MARKUP keeps reference source out of every runner. */
export function isOutputReferenceCell(
  cell?: Pick<parser_pb.Cell, 'languageId'> | null
): boolean {
  return cell?.languageId?.trim().toLowerCase() === OUTPUT_REFERENCE_LANGUAGE
}

/** Parse a single inert anchor. Reference source is never inserted into the DOM. */
export function parseOutputReference(source: string): OutputReference {
  const document = new DOMParser().parseFromString(source, 'text/html')
  const nodes = [...document.body.childNodes].filter(
    (node) => node.nodeType !== 3 || node.textContent?.trim()
  )
  const anchor = nodes[0]
  if (
    document.head.childNodes.length ||
    nodes.length !== 1 ||
    !(anchor instanceof HTMLAnchorElement) ||
    anchor.children.length ||
    anchor.attributes.length !== 1 ||
    !anchor.hasAttribute('href')
  ) {
    throw new Error(
      'Enter one HTML link: <a href="#cell=…&amp;version=operation%3A…&amp;output_item=0.0">Result</a>'
    )
  }
  const href = anchor.getAttribute('href') ?? ''
  if (!href.startsWith('#'))
    throw new Error(
      'Reference cells currently support links within this .runme notebook only.'
    )
  const params = new URLSearchParams(href.slice(1))
  const keys = [...params.keys()]
  if (
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    keys.some((key) => !['cell', 'version', 'output_item'].includes(key))
  ) {
    throw new Error(
      'The link must specify cell, version, and output_item exactly once.'
    )
  }
  const cellId = params.get('cell') ?? ''
  const version = params.get('version')?.match(/^(operation|revision):(.+)$/)
  const item = params.get('output_item')?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (
    !cellId.trim() ||
    !version ||
    !item ||
    !Number.isSafeInteger(Number(item[1])) ||
    !Number.isSafeInteger(Number(item[2]))
  ) {
    throw new Error(
      'The link needs a cell ID, an immutable operation/revision version, and zero-based output.item indices.'
    )
  }
  return {
    cellId,
    version:
      version[1] === 'operation'
        ? { kind: 'operation', op_id: version[2] }
        : { kind: 'revision', revision_id: version[2] },
    outputIndex: Number(item[1]),
    itemIndex: Number(item[2]),
  }
}

/** Format the same tuple used by the resolver; no execution metadata is duplicated. */
export function formatOutputReference(reference: OutputReference): string {
  const version = reference.version
  const params = new URLSearchParams({
    cell: reference.cellId,
    version:
      version.kind === 'operation'
        ? `operation:${version.op_id}`
        : `revision:${version.revision_id}`,
    output_item: `${reference.outputIndex}.${reference.itemIndex}`,
  })
  return `<a href="#${params.toString().replace(/&/g, '&amp;')}">Output ${reference.outputIndex}.${reference.itemIndex}</a>`
}

/** Resolve only the pinned causal past, even after later runs, clears, or deletes. */
export function resolveOutputReference(
  operations: RunmeOperation[],
  reference: OutputReference
): ResolvedOutputReference {
  const selected = resolveVersion(operations, reference.version)
  const snapshot = materializeOperationLog(selected)
  const cell = snapshot.notebook.cells.find(
    (cell) => cell.cell_id === reference.cellId
  )
  if (!cell)
    throw new Error('The referenced cell is unavailable at this version.')
  if (cell.output_error) throw new Error(cell.output_error)
  const execution = snapshot.executions.find(
    (execution) => execution.execution_id === cell.output_execution_id
  )
  if (!execution?.finish || execution.finish_error)
    throw new Error(
      execution?.finish_error ??
        'The referenced version has no completed saved execution.'
    )
  const output = cell.outputs[reference.outputIndex]
  if (!output) throw new Error('The referenced output is unavailable.')
  const item = fromJson(parser_pb.CellOutputSchema, output).items[
    reference.itemIndex
  ]
  if (!item) throw new Error('The referenced output item is unavailable.')
  const result: ResolvedOutputReference = {
    item,
    executionId: execution.execution_id,
    status: execution.finish.status,
    language: execution.start.input.language_id,
  }
  try {
    // A save after execution may contain newer source. Follow the start's source
    // operation within its causal past, never the cell source at the finish.
    // Read the exact source record, including a member of a committed
    // transaction. Resolving that member as a standalone version would reject
    // it for lacking its later commit, even though the output version has it.
    const sourceOperation = ancestorClosure(selected, [
      execution.start_operation_id,
    ]).find((operation) => operation.op_id === execution.start.source_op_id)
    if (
      !sourceOperation ||
      !['cell.create', 'cell.update'].includes(sourceOperation.kind)
    )
      throw new Error('Source operation is unavailable.')
    const sourceRecord = sourceOperation.payload as unknown as CellUpdatePayload
    const source = sourceRecord.cell.value
    if (
      sourceRecord.cell_id !== reference.cellId ||
      source !== execution.start.input.value ||
      sourceRecord.cell.language_id !== execution.start.input.language_id
    )
      throw new Error('Recorded source does not match the execution input.')
    result.source = source
    result.sourceOperationId = execution.start.source_op_id
  } catch {
    result.provenanceError =
      'The exact historical source is unavailable for this execution.'
  }
  return result
}

/** Use the finish already persisted by autosave. No named checkpoint is created. */
export function referenceForOutput(
  operations: RunmeOperation[],
  cellId: string,
  outputIndex: number,
  itemIndex: number
): OutputReference {
  const snapshot = materializeOperationLog(operations)
  const cell = snapshot.notebook.cells.find((cell) => cell.cell_id === cellId)
  if (cell?.output_error) throw new Error(cell.output_error)
  const execution = snapshot.executions.find(
    (execution) => execution.execution_id === cell?.output_execution_id
  )
  if (!execution?.finish_operation_id || execution.finish_error)
    throw new Error(
      'Wait for the cell to complete and its output to save before copying a reference.'
    )
  const finish = operations.find(
    (op) => op.op_id === execution.finish_operation_id
  )!
  // Imported logs may commit a finish as part of a transaction. Pin its commit
  // so version resolution includes all members of that immutable transaction.
  const versionOperation = finish.transaction_id
    ? operations.find(
        (op) =>
          op.kind === 'transaction.commit' &&
          (op.payload as { transaction_id?: string }).transaction_id ===
            finish.transaction_id
      )
    : finish
  if (!versionOperation)
    throw new Error('The output transaction is not committed yet.')
  const reference: OutputReference = {
    cellId,
    version: { kind: 'operation', op_id: versionOperation.op_id },
    outputIndex,
    itemIndex,
  }
  const resolved = resolveOutputReference(operations, reference)
  if (resolved.executionId !== execution.execution_id)
    throw new Error(
      'The saved version does not uniquely identify this execution.'
    )
  return reference
}
