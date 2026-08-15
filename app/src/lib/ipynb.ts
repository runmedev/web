import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'
import md5 from 'md5'

import { MimeType, parser_pb } from '../runme/client'
import {
  LEGACY_IPYNB_CELL_ID_METADATA_KEY,
  assertCanonicalNotebookCellIds,
  uniqueCanonicalCellId,
} from './cellIdentity'

export const IPYNB_MIME_TYPE = 'application/x-ipynb+json'
export const IPYNB_RAW_CELL_METADATA_KEY = 'runme.dev/ipynbRawCell'

const IPYNB_OUTPUT_TYPE = 'runme.dev/ipynbOutputType'
const IPYNB_OUTPUT_METADATA = 'runme.dev/ipynbOutputMetadata'
const IPYNB_EXECUTION_COUNT = 'runme.dev/ipynbExecutionCount'
const IPYNB_ERROR = 'runme.dev/ipynbError'
const RUNME_IPYNB_METADATA_KEY = 'runme'
const RUNME_IPYNB_METADATA_VERSION = 1

const PROTO_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]

type JsonObject = Record<string, unknown>

export interface IpynbNotebook extends JsonObject {
  cells: IpynbCell[]
  metadata: JsonObject
  nbformat: number
  nbformat_minor: number
}

export interface IpynbCell extends JsonObject {
  cell_type: 'code' | 'markdown' | 'raw'
  id?: string
  metadata: JsonObject
  source: string | string[]
  outputs?: IpynbOutput[]
  execution_count?: number | null
  attachments?: JsonObject
}

export type IpynbOutput = JsonObject & {
  output_type: string
}

export interface DecodedIpynb {
  notebook: parser_pb.Notebook
  source: IpynbNotebook
  jupyterIdByRunmeRefId: Record<string, string>
  baselineCellHashes: Record<string, string>
  baselineOutputHashes: Record<string, string>
}

export interface IpynbMergeState {
  jupyterIdByRunmeRefId: Record<string, string>
  baselineCellHashes: Record<string, string>
  baselineOutputHashes: Record<string, string>
}

export interface EncodedIpynb {
  text: string
  state: IpynbMergeState
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as JsonObject
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function optionalObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function embeddedRunmeCell(metadata: JsonObject): parser_pb.Cell | undefined {
  const runme = optionalObject(metadata[RUNME_IPYNB_METADATA_KEY])
  const cell = optionalObject(runme?.cell)
  if (!cell) {
    return undefined
  }
  try {
    return fromJsonString(parser_pb.CellSchema, JSON.stringify(cell), {
      ignoreUnknownFields: true,
    })
  } catch {
    return undefined
  }
}

function embeddedRunmeNotebook(
  metadata: JsonObject
): parser_pb.Notebook | undefined {
  const runme = optionalObject(metadata[RUNME_IPYNB_METADATA_KEY])
  const notebook = optionalObject(runme?.notebook)
  if (!notebook) {
    return undefined
  }
  try {
    return fromJsonString(parser_pb.NotebookSchema, JSON.stringify(notebook), {
      ignoreUnknownFields: true,
    })
  } catch {
    return undefined
  }
}

function runmeCellEnvelope(cell: parser_pb.Cell): JsonObject {
  const json = JSON.parse(
    toJsonString(parser_pb.CellSchema, cell, PROTO_JSON_WRITE_OPTIONS)
  ) as JsonObject
  delete json.kind
  delete json.value
  delete json.outputs
  delete json.executionSummary
  delete json.refId
  const metadata = optionalObject(json.metadata)
  if (metadata) {
    delete metadata[LEGACY_IPYNB_CELL_ID_METADATA_KEY]
    delete metadata[IPYNB_RAW_CELL_METADATA_KEY]
    if (Object.keys(metadata).length === 0) {
      delete json.metadata
    }
  }
  return json
}

function runmeNotebookEnvelope(notebook: parser_pb.Notebook): JsonObject {
  const json = JSON.parse(
    toJsonString(parser_pb.NotebookSchema, notebook, PROTO_JSON_WRITE_OPTIONS)
  ) as JsonObject
  delete json.cells
  const metadata = optionalObject(json.metadata)
  if (metadata) {
    delete metadata['runme.dev/ipynb']
    if (Object.keys(metadata).length === 0) {
      delete json.metadata
    }
  }
  return json
}

function sourceText(source: unknown): string {
  if (typeof source === 'string') {
    return source
  }
  if (
    Array.isArray(source) &&
    source.every((part) => typeof part === 'string')
  ) {
    return source.join('')
  }
  throw new Error('Jupyter cell source must be a string or string array')
}

function languageIdForNotebook(metadata: JsonObject): string {
  const kernelspec =
    metadata.kernelspec && typeof metadata.kernelspec === 'object'
      ? (metadata.kernelspec as JsonObject)
      : undefined
  const languageInfo =
    metadata.language_info && typeof metadata.language_info === 'object'
      ? (metadata.language_info as JsonObject)
      : undefined
  return (
    (typeof kernelspec?.language === 'string'
      ? kernelspec.language
      : undefined) ??
    (typeof languageInfo?.name === 'string' ? languageInfo.name : undefined) ??
    'python'
  )
}

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join('')
  }
  return JSON.stringify(value)
}

function outputItem(mime: string, value: unknown): parser_pb.CellOutputItem {
  return create(parser_pb.CellOutputItemSchema, {
    mime,
    type: 'Buffer',
    data: encoder.encode(textValue(value)),
  })
}

function ipynbOutputToRunme(output: IpynbOutput): parser_pb.CellOutput {
  const metadata: Record<string, string> = {
    [IPYNB_OUTPUT_TYPE]: output.output_type,
  }
  if (output.metadata && typeof output.metadata === 'object') {
    metadata[IPYNB_OUTPUT_METADATA] = JSON.stringify(output.metadata)
  }
  if (
    output.execution_count === null ||
    typeof output.execution_count === 'number'
  ) {
    metadata[IPYNB_EXECUTION_COUNT] = JSON.stringify(output.execution_count)
  }

  if (output.output_type === 'stream') {
    const streamName = output.name === 'stderr' ? 'stderr' : 'stdout'
    return create(parser_pb.CellOutputSchema, {
      metadata,
      items: [
        outputItem(
          streamName === 'stderr'
            ? MimeType.VSCodeNotebookStdErr
            : MimeType.VSCodeNotebookStdOut,
          output.text
        ),
      ],
    })
  }

  if (output.output_type === 'error') {
    metadata[IPYNB_ERROR] = JSON.stringify({
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback,
    })
    return create(parser_pb.CellOutputSchema, {
      metadata,
      items: [
        outputItem('application/vnd.code.notebook.error', {
          ename: output.ename,
          evalue: output.evalue,
          traceback: output.traceback,
        }),
      ],
    })
  }

  const data =
    output.data && typeof output.data === 'object'
      ? (output.data as JsonObject)
      : {}
  return create(parser_pb.CellOutputSchema, {
    metadata,
    items: Object.entries(data).map(([mime, value]) => outputItem(mime, value)),
  })
}

function runmeOutputToIpynb(output: parser_pb.CellOutput): IpynbOutput {
  const outputType = output.metadata?.[IPYNB_OUTPUT_TYPE]
  if (
    output.items.length === 1 &&
    (output.items[0]?.mime === MimeType.VSCodeNotebookStdOut ||
      output.items[0]?.mime === MimeType.VSCodeNotebookStdErr)
  ) {
    const item = output.items[0]
    return {
      output_type: 'stream',
      name: item.mime === MimeType.VSCodeNotebookStdErr ? 'stderr' : 'stdout',
      text: decoder.decode(item.data),
    }
  }

  if (outputType === 'error' || output.metadata?.[IPYNB_ERROR]) {
    const error = JSON.parse(
      output.metadata?.[IPYNB_ERROR] ??
        decoder.decode(output.items[0]?.data ?? new Uint8Array())
    ) as JsonObject
    return {
      output_type: 'error',
      ename: typeof error.ename === 'string' ? error.ename : 'Error',
      evalue: typeof error.evalue === 'string' ? error.evalue : '',
      traceback: Array.isArray(error.traceback) ? error.traceback : [],
    }
  }

  const data: JsonObject = {}
  for (const item of output.items) {
    const text = decoder.decode(item.data)
    if (
      item.mime === 'application/json' ||
      item.mime.endsWith('+json') ||
      item.mime === 'application/vnd.plotly.v1+json'
    ) {
      try {
        data[item.mime] = JSON.parse(text)
        continue
      } catch {
        // Preserve malformed JSON-valued output as text instead of dropping it.
      }
    }
    data[item.mime || 'text/plain'] = text
  }

  const executionCount = output.metadata?.[IPYNB_EXECUTION_COUNT]
  const metadata = output.metadata?.[IPYNB_OUTPUT_METADATA]
  return {
    output_type:
      outputType === 'execute_result' ? 'execute_result' : 'display_data',
    data,
    metadata: metadata ? JSON.parse(metadata) : {},
    ...(outputType === 'execute_result'
      ? {
          execution_count: executionCount
            ? (JSON.parse(executionCount) as number | null)
            : null,
        }
      : {}),
  }
}

function outputHash(cell: parser_pb.Cell): string {
  return md5(
    JSON.stringify(
      cell.outputs.map((output) => ({
        metadata: output.metadata,
        items: output.items.map((item) => ({
          mime: item.mime,
          type: item.type,
          data: Array.from(item.data),
        })),
      }))
    )
  )
}

function cellHash(cell: parser_pb.Cell): string {
  return md5(
    JSON.stringify({
      kind: cell.kind,
      value: cell.value,
      languageId: cell.languageId,
      raw: cell.metadata?.[IPYNB_RAW_CELL_METADATA_KEY] ?? '',
    })
  )
}

function validateNotebook(value: unknown): IpynbNotebook {
  const document = asObject(value, 'Jupyter notebook')
  if (document.nbformat !== 4) {
    throw new Error(
      `Unsupported Jupyter nbformat major version: ${String(document.nbformat)}`
    )
  }
  if (!Array.isArray(document.cells)) {
    throw new Error('Jupyter notebook cells must be an array')
  }
  document.metadata = asObject(
    document.metadata,
    'Jupyter notebook metadata'
  )
  return document as unknown as IpynbNotebook
}

export function createEmptyIpynb(): IpynbNotebook {
  return {
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }
}

export function decodeIpynb(text: string): DecodedIpynb {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid Jupyter notebook JSON: ${String(error)}`)
  }
  const source = validateNotebook(parsed)
  const languageId = languageIdForNotebook(source.metadata)
  const preservedNotebook = embeddedRunmeNotebook(source.metadata)
  const usedIds = new Set<string>()
  const jupyterIdByRunmeRefId: Record<string, string> = {}
  const baselineCellHashes: Record<string, string> = {}
  const baselineOutputHashes: Record<string, string> = {}

  const cells = source.cells.map((input, index) => {
    const sourceCell = asObject(input, `Jupyter cell ${index}`) as IpynbCell
    if (
      sourceCell.cell_type !== 'code' &&
      sourceCell.cell_type !== 'markdown' &&
      sourceCell.cell_type !== 'raw'
    ) {
      throw new Error(
        `Unsupported Jupyter cell type: ${String(sourceCell.cell_type)}`
      )
    }
    sourceCell.metadata = asObject(
      sourceCell.metadata,
      `Jupyter cell ${index} metadata`
    )
    const id = uniqueCanonicalCellId(sourceCell.id, index, usedIds)
    // Treat nbformat cell IDs as repairable input. Keeping the repaired value
    // in the shadow makes the next save both valid and lossless for the rest
    // of the cell object.
    sourceCell.id = id
    const preservedCell = embeddedRunmeCell(sourceCell.metadata)
    const kind =
      sourceCell.cell_type === 'code'
        ? parser_pb.CellKind.CODE
        : parser_pb.CellKind.MARKUP
    const refId = id
    const metadata: Record<string, string> = {
      ...(preservedCell?.metadata ?? {}),
    }
    delete metadata[LEGACY_IPYNB_CELL_ID_METADATA_KEY]
    if (sourceCell.cell_type === 'raw') {
      metadata[IPYNB_RAW_CELL_METADATA_KEY] = 'true'
    }
    const cell = create(parser_pb.CellSchema, {
      kind,
      refId,
      value: sourceText(sourceCell.source),
      languageId:
        preservedCell?.languageId ||
        (sourceCell.cell_type === 'code'
          ? languageId
          : sourceCell.cell_type === 'raw'
            ? 'text'
            : 'markdown'),
      metadata,
      textRange: preservedCell?.textRange,
      outputs:
        sourceCell.cell_type === 'code' && Array.isArray(sourceCell.outputs)
          ? sourceCell.outputs.map((output) =>
              ipynbOutputToRunme(
                asObject(output, `Jupyter output in cell ${id}`) as IpynbOutput
              )
            )
          : [],
      executionSummary:
        sourceCell.cell_type === 'code' &&
        typeof sourceCell.execution_count === 'number'
          ? create(parser_pb.CellExecutionSummarySchema, {
              executionOrder: sourceCell.execution_count,
            })
          : undefined,
      role: preservedCell?.role,
      callId: preservedCell?.callId,
      docResults: preservedCell?.docResults,
    })
    jupyterIdByRunmeRefId[refId] = id
    baselineCellHashes[refId] = cellHash(cell)
    baselineOutputHashes[refId] = outputHash(cell)
    return cell
  })

  return {
    notebook: create(parser_pb.NotebookSchema, {
      cells,
      metadata: {
        ...(preservedNotebook?.metadata ?? {}),
        'runme.dev/ipynb': 'true',
      },
      frontmatter: preservedNotebook?.frontmatter,
    }),
    source,
    jupyterIdByRunmeRefId,
    baselineCellHashes,
    baselineOutputHashes,
  }
}

export function encodeIpynb(
  notebook: parser_pb.Notebook,
  shadowText?: string,
  previousState?: Partial<IpynbMergeState>
): EncodedIpynb {
  assertCanonicalNotebookCellIds(notebook)
  const shadow = shadowText
    ? validateNotebook(JSON.parse(shadowText))
    : createEmptyIpynb()
  const sourceById = new Map(
    shadow.cells
      .filter((cell) => typeof cell.id === 'string')
      .map((cell) => [cell.id as string, cell])
  )
  const jupyterIdByRunmeRefId: Record<string, string> = {}
  const baselineCellHashes: Record<string, string> = {}
  const baselineOutputHashes: Record<string, string> = {}
  const previousRefIdByJupyterId = new Map(
    Object.entries(previousState?.jupyterIdByRunmeRefId ?? {}).map(
      ([refId, jupyterId]) => [jupyterId, refId]
    )
  )

  const cells = notebook.cells.map((cell): IpynbCell => {
    const id = cell.refId
    const matched = sourceById.get(id)
    const previousRefId = previousRefIdByJupyterId.get(id)
    const baselineRefId =
      previousState?.baselineOutputHashes?.[cell.refId] !== undefined
        ? cell.refId
        : previousRefId
    const outputUnchanged =
      (baselineRefId
        ? previousState?.baselineOutputHashes?.[baselineRefId]
        : undefined) === outputHash(cell)
    const raw = cell.metadata?.[IPYNB_RAW_CELL_METADATA_KEY] === 'true'
    const cellType: IpynbCell['cell_type'] =
      cell.kind === parser_pb.CellKind.CODE ? 'code' : raw ? 'raw' : 'markdown'
    const result: IpynbCell = matched
      ? cloneJson(matched)
      : {
          cell_type: cellType,
          id,
          metadata: {},
          source: '',
        }
    result.cell_type = cellType
    result.id = id
    result.source = cell.value
    result.metadata =
      result.metadata && typeof result.metadata === 'object'
        ? result.metadata
        : {}
    const existingRunme = optionalObject(
      result.metadata[RUNME_IPYNB_METADATA_KEY]
    )
    result.metadata[RUNME_IPYNB_METADATA_KEY] = {
      ...(existingRunme ? cloneJson(existingRunme) : {}),
      version: RUNME_IPYNB_METADATA_VERSION,
      cell: runmeCellEnvelope(cell),
    }

    if (cellType === 'code') {
      result.execution_count = cell.executionSummary?.executionOrder ?? null
      result.outputs =
        matched && outputUnchanged && Array.isArray(matched.outputs)
          ? cloneJson(matched.outputs)
          : cell.outputs.map(runmeOutputToIpynb)
    } else {
      delete result.outputs
      delete result.execution_count
    }

    jupyterIdByRunmeRefId[cell.refId] = id
    baselineCellHashes[cell.refId] = cellHash(cell)
    baselineOutputHashes[cell.refId] = outputHash(cell)
    return result
  })

  const next: IpynbNotebook = {
    ...cloneJson(shadow),
    cells,
    metadata: cloneJson(shadow.metadata ?? {}),
    nbformat: 4,
    nbformat_minor:
      typeof shadow.nbformat_minor === 'number' ? shadow.nbformat_minor : 5,
  }
  const existingRunme = optionalObject(next.metadata[RUNME_IPYNB_METADATA_KEY])
  next.metadata[RUNME_IPYNB_METADATA_KEY] = {
    ...(existingRunme ? cloneJson(existingRunme) : {}),
    version: RUNME_IPYNB_METADATA_VERSION,
    notebook: runmeNotebookEnvelope(notebook),
  }
  return {
    text: `${JSON.stringify(next, null, 2)}\n`,
    state: {
      jupyterIdByRunmeRefId,
      baselineCellHashes,
      baselineOutputHashes,
    },
  }
}
