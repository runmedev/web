import type { NotebookDiff } from '../notebookDiff/model'
import type {
  ClassifierInput,
  ExamplesHeader,
  ExtractedExamples,
  TrainingExample,
} from './model'

/** A worker job carries a locator, never a cloned notebook history. */
export interface ExampleJob {
  localUri: string
  sourcePath: string
  driveFileId?: string
  name: string
}
export interface ExampleIndex extends ExtractedExamples {
  header: ExamplesHeader
  sidecarPath: string
}
export type ExampleRequest =
  | { id: number; kind: 'generate'; job: ExampleJob }
  | { id: number; kind: 'preview'; job: ExampleJob; example: TrainingExample }
export interface ExamplePreview {
  input: ClassifierInput
  diff: NotebookDiff
}
export type ExampleResponse =
  | { id: number; kind: 'generate'; result: ExampleIndex }
  | { id: number; kind: 'preview'; result: ExamplePreview }
  | { id: number; kind: 'error'; error: string }
