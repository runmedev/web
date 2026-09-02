import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'

import { parser_pb } from '../runme/client'
import { migrateNotebookCellIds } from './cellIdentity'
import {
  type DecodedIpynb,
  type EncodedIpynb,
  createEmptyIpynb,
  decodeIpynb,
  encodeIpynb,
} from './ipynb'
import { appLogger } from './logging/runtime'

const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]

export type NotebookFileFormat = 'runme-json' | 'ipynb'

export interface DecodedNotebookFile {
  format: NotebookFileFormat
  notebook: parser_pb.Notebook
  ipynb?: DecodedIpynb
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
  if (
    currentFormat &&
    requestedFormat &&
    currentFormat !== requestedFormat
  ) {
    throw new Error(
      'Changing notebook formats by rename is not supported. Use Save as instead.'
    )
  }
  if (
    currentFormat &&
    !requestedFormat &&
    /\.[^/]+$/.test(nextName.trim())
  ) {
    throw new Error(`Unsupported notebook file extension: ${nextName}`)
  }
}

export function isNotebookFileName(fileName: string): boolean {
  return detectNotebookFileFormat(fileName) !== null
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
  throw new Error(`Unsupported notebook file extension: ${fileName}`)
}
