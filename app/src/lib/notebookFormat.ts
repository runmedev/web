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

const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]

export type NotebookFileFormat = 'runme-json' | 'ipynb'

export interface DecodedNotebookFile {
  format: NotebookFileFormat
  notebook: parser_pb.Notebook
  ipynb?: DecodedIpynb
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
    const ipynb = decodeIpynb(text)
    return { format, notebook: ipynb.notebook, ipynb }
  }
  const notebook = text
    ? fromJsonString(parser_pb.NotebookSchema, text, {
        ignoreUnknownFields: true,
      })
    : create(parser_pb.NotebookSchema, { cells: [] })
  migrateNotebookCellIds(notebook)
  return { format, notebook }
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
