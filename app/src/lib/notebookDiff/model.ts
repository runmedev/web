import type { parser_pb } from '../../runme/client'

export type TextDiffLineKind = 'equal' | 'removed' | 'added'

export interface TextDiffLine {
  kind: TextDiffLineKind
  baseLine?: string
  compareLine?: string
}

export interface TextDiff {
  changed: boolean
  lines: TextDiffLine[]
}

export interface MetadataDiff {
  changed: boolean
  base: Record<string, string>
  compare: Record<string, string>
}

export interface OutputItemSummary {
  mime: string
  kind: 'text' | 'binary'
  text?: string
  sizeBytes: number
  checksum: string
}

export interface OutputDiff {
  changed: boolean
  baseItems: OutputItemSummary[]
  compareItems: OutputItemSummary[]
  textDiff?: TextDiff
}

export type CellDiffKind = 'unchanged' | 'inserted' | 'deleted' | 'modified'

export interface CellDiff {
  id: string
  kind: CellDiffKind
  baseIndex?: number
  compareIndex?: number
  moved: boolean
  baseCell?: parser_pb.Cell
  compareCell?: parser_pb.Cell
  sourceDiff?: TextDiff
  metadataDiff?: MetadataDiff
  outputDiff?: OutputDiff
  changedFields: Array<
    'source' | 'metadata' | 'outputs' | 'kind' | 'language' | 'move'
  >
}

export interface NotebookDiffSummary {
  unchangedCells: number
  insertedCells: number
  deletedCells: number
  modifiedCells: number
  movedCells: number
  sourceChanges: number
  metadataChanges: number
  outputChanges: number
}

export interface NotebookDiff {
  baseLabel?: string
  compareLabel?: string
  cells: CellDiff[]
  summary: NotebookDiffSummary
}

export interface NotebookDiffOptions {
  includeOutputs?: boolean
  includeMetadata?: boolean
  ignoreTransientMetadata?: boolean
}

export interface NotebookDiffDocument {
  id: string
  base: {
    label: string
    revisionId?: string
  }
  compare: {
    label: string
    revisionId?: string
  }
  diff: NotebookDiff
  resolution?: {
    kind: 'notebook-sync-conflict'
    localUri: string
  }
}
