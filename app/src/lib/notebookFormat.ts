import { clone, create, fromJsonString, toJsonString } from '@bufbuild/protobuf'

import { RunmeMetadataKey, parser_pb } from '../runme/client'
import { migrateNotebookCellIds } from './cellIdentity'
import {
  type DecodedIpynb,
  type EncodedIpynb,
  createEmptyIpynb,
  decodeIpynb,
  encodeIpynb,
} from './ipynb'
import { appLogger } from './logging/runtime'
import {
  type NotebookLogHeader,
  type ParsedOperationLog,
  buildOperationLogDiff,
  materializeOperationLog,
  materializedLogToNotebook,
  parseOperationLog,
  serializeOperationLog,
} from './operationLog'

const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]

export const RUNME_OPERATION_LOG_MIME_TYPE =
  'application/vnd.runme.notebook+jsonl'

export type NotebookFileFormat = 'runme-json' | 'ipynb' | 'runme-operation-log'

export interface ConvertedRunmeNotebookFile {
  fileName: string
  notebook: parser_pb.Notebook
  content: string
}

export function notebookFileExtension(format: NotebookFileFormat): string {
  switch (format) {
    case 'runme-json':
      return '.json'
    case 'ipynb':
      return '.ipynb'
    case 'runme-operation-log':
      return '.runme'
  }
}

export interface DecodedNotebookFile {
  format: NotebookFileFormat
  notebook: parser_pb.Notebook
  ipynb?: DecodedIpynb
  operationLog?: ParsedOperationLog
  recovery?: NotebookFileRecovery
}

export interface NotebookFileRecovery {
  sourceFormat: 'runme-json'
  reason: 'ipynb-content-mismatch'
  cellCount: number
}

export interface RunmeNotebookJsonShape {
  cellCount: number
  hasRunmeEvidence: boolean
}

const RUNME_NOTEBOOK_JSON_FIELDS = new Set(['cells', 'metadata', 'frontmatter'])
const RUNME_CELL_JSON_FIELDS = new Set([
  'kind',
  'value',
  'languageId',
  'language_id',
  'metadata',
  'textRange',
  'text_range',
  'outputs',
  'executionSummary',
  'execution_summary',
  'refId',
  'ref_id',
  'role',
  'callId',
  'call_id',
  'docResults',
  'doc_results',
])
const RUNME_CELL_EVIDENCE_FIELDS = new Set([
  'kind',
  'value',
  'languageId',
  'language_id',
  'textRange',
  'text_range',
  'executionSummary',
  'execution_summary',
  'refId',
  'ref_id',
  'role',
  'callId',
  'call_id',
  'docResults',
  'doc_results',
])

/**
 * Recognizes protobuf JSON emitted for a Runme notebook without treating an
 * arbitrary object with a `cells` array as valid. `hasRunmeEvidence` is false
 * for default-only protobuf JSON such as `{}` and prevents current-file
 * recovery from guessing when the bytes are ambiguous.
 */
export function inspectRunmeNotebookJsonShape(
  text: string
): RunmeNotebookJsonShape | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  const notebook = parsed as Record<string, unknown>
  if ('nbformat' in notebook) {
    return null
  }
  if (
    !Object.keys(notebook).every((key) => RUNME_NOTEBOOK_JSON_FIELDS.has(key))
  ) {
    return null
  }
  if (notebook.cells !== undefined && !Array.isArray(notebook.cells)) {
    return null
  }

  const cells = (notebook.cells ?? []) as unknown[]
  let hasRunmeEvidence = false
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
      return null
    }
    const keys = Object.keys(cell)
    if (!keys.every((key) => RUNME_CELL_JSON_FIELDS.has(key))) {
      return null
    }
    if (keys.some((key) => RUNME_CELL_EVIDENCE_FIELDS.has(key))) {
      hasRunmeEvidence = true
    }
  }

  const metadata = notebook.metadata
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.keys(metadata).some((key) => key.startsWith('runme.dev/'))
  ) {
    hasRunmeEvidence = true
  }

  return { cellCount: cells.length, hasRunmeEvidence }
}

function decodeRunmeNotebook(text: string): parser_pb.Notebook {
  const notebook = text
    ? fromJsonString(parser_pb.NotebookSchema, text, {
        ignoreUnknownFields: true,
      })
    : create(parser_pb.NotebookSchema, { cells: [] })
  migrateNotebookCellIds(notebook)
  return notebook
}

function decodeLegacyRunmeNotebookStrict(text: string): parser_pb.Notebook {
  if (!inspectRunmeNotebookJsonShape(text)) {
    throw new Error('Legacy .json file is not a Runme notebook')
  }
  const notebook = fromJsonString(parser_pb.NotebookSchema, text)
  migrateNotebookCellIds(notebook)
  return notebook
}

export function detectNotebookFileFormat(
  fileName: string
): NotebookFileFormat | null {
  const normalized = fileName.trim().toLowerCase()
  if (normalized.endsWith('.ipynb')) {
    return 'ipynb'
  }
  if (normalized.endsWith('.json')) {
    return 'runme-json'
  }
  if (normalized.endsWith('.runme')) {
    return 'runme-operation-log'
  }
  return null
}

/**
 * Rejects rename requests that change notebook format or use an unsupported
 * extension. Extensionless names remain valid so each storage implementation
 * can normalize them by appending the current notebook's extension.
 */
export function validateNotebookRenameFormat(
  currentName: string,
  nextName: string
): void {
  const currentFormat = detectNotebookFileFormat(currentName)
  const requestedFormat = detectNotebookFileFormat(nextName)
  if (currentFormat && requestedFormat && currentFormat !== requestedFormat) {
    throw new Error(
      'Changing notebook formats by rename is not supported. Use Save as instead.'
    )
  }
  if (currentFormat && !requestedFormat && /\.[^/]+$/.test(nextName.trim())) {
    throw new Error(`Unsupported notebook file extension: ${nextName}`)
  }
}

export function isNotebookFileName(fileName: string): boolean {
  return detectNotebookFileFormat(fileName) !== null
}

export function isLegacyNotebookFileName(fileName: string): boolean {
  const format = detectNotebookFileFormat(fileName)
  return format === 'runme-json' || format === 'ipynb'
}

export function runmeFileNameForLegacyNotebook(fileName: string): string {
  const trimmed = fileName.trim()
  const format = detectNotebookFileFormat(trimmed)
  if (format !== 'runme-json' && format !== 'ipynb') {
    throw new Error(
      `Legacy notebook file name must end in .json or .ipynb: ${fileName}`
    )
  }
  const extension = notebookFileExtension(format)
  const title = trimmed.slice(0, -extension.length)
  if (!title) {
    throw new Error('Legacy notebook file name must include a title')
  }
  return `${title}.runme`
}

async function hashOperationLogIdentity(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

/** Encode a materialized notebook as a self-contained .runme operation log. */
export async function encodeRunmeOperationLogSnapshot(
  notebook: parser_pb.Notebook,
  stableIdentity?: string
): Promise<string> {
  const seed = stableIdentity
    ? await hashOperationLogIdentity(`${stableIdentity}\u0000runme`)
    : globalThis.crypto.randomUUID().replace(/-/g, '')
  const createdAt = stableIdentity
    ? '1970-01-01T00:00:00.000Z'
    : new Date().toISOString()
  const header: NotebookLogHeader = {
    record_type: 'runme.notebook',
    format_version: 1,
    notebook_id: `notebook_${seed}`,
    created_by: `actor_${seed}`,
    created_at: createdAt,
  }
  return encodeRunmeOperationLogSnapshotWithHeader(notebook, header)
}

/** Rebuild a snapshot while retaining an existing .runme document identity. */
export async function encodeRunmeOperationLogSnapshotWithHeader(
  notebook: parser_pb.Notebook,
  header: NotebookLogHeader
): Promise<string> {
  const operations = await buildOperationLogDiff({
    previous: create(parser_pb.NotebookSchema, { cells: [] }),
    next: notebook,
    observedOperations: [],
    actorId: header.created_by,
    firstActorSequence: 1,
    createdAt: () => header.created_at,
  })
  return serializeOperationLog(header, operations)
}

/**
 * Convert a parsed legacy notebook into a new .runme document without
 * carrying over external comments. The input notebook is never mutated.
 */
export async function convertLegacyNotebookToRunme(
  notebook: parser_pb.Notebook,
  sourceFileName: string,
  options: { originalGoogleDriveId?: string } = {}
): Promise<ConvertedRunmeNotebookFile> {
  const converted = clone(parser_pb.NotebookSchema, notebook)
  migrateNotebookCellIds(converted)
  converted.metadata = { ...converted.metadata }
  if (options.originalGoogleDriveId) {
    converted.metadata[RunmeMetadataKey.OriginalGoogleDriveID] =
      options.originalGoogleDriveId
  }
  return {
    fileName: runmeFileNameForLegacyNotebook(sourceFileName),
    notebook: converted,
    content: await encodeRunmeOperationLogSnapshot(converted),
  }
}

/** Convert raw legacy notebook bytes into a new .runme document. */
export async function convertLegacyNotebookFileToRunme(
  text: string,
  sourceFileName: string,
  options: { originalGoogleDriveId?: string } = {}
): Promise<ConvertedRunmeNotebookFile> {
  if (detectNotebookFileFormat(sourceFileName) === 'runme-json') {
    return convertLegacyNotebookToRunme(
      decodeLegacyRunmeNotebookStrict(text),
      sourceFileName,
      options
    )
  }
  const decoded = decodeNotebookFile(text, sourceFileName)
  if (decoded.format === 'runme-operation-log') {
    throw new Error('Only .json and .ipynb notebooks can be converted')
  }
  return convertLegacyNotebookToRunme(decoded.notebook, sourceFileName, options)
}

export function decodeNotebookFile(
  text: string,
  fileName: string
): DecodedNotebookFile {
  const format = detectNotebookFileFormat(fileName)
  if (!format) {
    throw new Error(`Unsupported notebook file extension: ${fileName}`)
  }
  if (format === 'ipynb') {
    try {
      const ipynb = decodeIpynb(text)
      return { format, notebook: ipynb.notebook, ipynb }
    } catch (ipynbError) {
      const shape = inspectRunmeNotebookJsonShape(text)
      if (!shape?.hasRunmeEvidence) {
        throw ipynbError
      }

      try {
        const recovered = decodeRunmeNotebook(text)
        const repaired = decodeIpynb(encodeIpynb(recovered).text)
        const recovery: NotebookFileRecovery = {
          sourceFormat: 'runme-json',
          reason: 'ipynb-content-mismatch',
          cellCount: shape.cellCount,
        }
        appLogger.warn('Recovered IPYNB from Runme JSON content', {
          attrs: {
            scope: 'notebook.format',
            code: 'IPYNB_RUNME_JSON_RECOVERY',
            ...recovery,
          },
        })
        return {
          format,
          notebook: repaired.notebook,
          ipynb: repaired,
          recovery,
        }
      } catch {
        throw ipynbError
      }
    }
  }
  if (format === 'runme-operation-log') {
    const operationLog = parseOperationLog(text)
    return {
      format,
      notebook: materializedLogToNotebook(
        materializeOperationLog(operationLog.operations)
      ),
      operationLog,
    }
  }
  return { format, notebook: decodeRunmeNotebook(text) }
}

export function encodeRunmeNotebook(notebook: parser_pb.Notebook): string {
  return toJsonString(
    parser_pb.NotebookSchema,
    notebook,
    NOTEBOOK_JSON_WRITE_OPTIONS
  )
}

export function encodeIpynbNotebook(
  notebook: parser_pb.Notebook,
  shadowText?: string,
  state?: Parameters<typeof encodeIpynb>[2]
): EncodedIpynb {
  return encodeIpynb(notebook, shadowText, state)
}

export function createInitialNotebookFile(fileName: string): string {
  const format = detectNotebookFileFormat(fileName)
  if (format === 'ipynb') {
    return `${JSON.stringify(createEmptyIpynb(), null, 2)}\n`
  }
  if (format === 'runme-json') {
    return encodeRunmeNotebook(create(parser_pb.NotebookSchema, { cells: [] }))
  }
  if (format === 'runme-operation-log') {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: `notebook_${id}`,
      created_by: 'runme-web',
      created_at: new Date().toISOString(),
    }
    return serializeOperationLog(header, [])
  }
  throw new Error(`Unsupported notebook file extension: ${fileName}`)
}
