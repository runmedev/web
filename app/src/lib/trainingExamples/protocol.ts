import type { NotebookDiff } from '../notebookDiff/model'
import type {
  ExtractedExamples,
  TrainingExample,
} from './model'
import type { PreparedExample } from './payloads'

/** A worker job carries a locator, never a cloned notebook history. */
export interface ExampleJob {
  localUri: string
  sourcePath: string
  driveFileId?: string
  name: string
}
export interface ExampleIndex extends ExtractedExamples {
  sourceChecksum: string
  ruleVersion: string
}
export interface ExtractionOptions {
  sources?: Array<'named-revision' | 'cell-decision'>
  syntheticReverse?: boolean
}
export type ExampleRequest =
  | { id: number; kind: 'generate'; job: ExampleJob; options?: ExtractionOptions }
  | { id: number; kind: 'preview'; job: ExampleJob; example: TrainingExample }
export interface ExamplePreview {
  input: PreparedExample
  diff: NotebookDiff
}
export type ExampleResponse =
  | { id: number; kind: 'generate'; result: ExampleIndex }
  | { id: number; kind: 'preview'; result: ExamplePreview }
  | { id: number; kind: 'error'; error: string }
