import { computeNotebookDiff } from './notebookDiff/diff'
import type {
  NotebookCellGrade,
  NotebookDocument,
} from './runtime/runmeConsole'
import { gradeSuggestion } from './suggestionGrader'
import { prepareSuggestionInput } from './suggestionGraderInput'

/** Grade the net content changes of one update, using immutable captured copies.
 * Two workers bound requests; errors remain advisory and never roll back edits.
 */
export async function gradeNotebookUpdate(
  before: NotebookDocument,
  after: NotebookDocument,
  signal?: AbortSignal
): Promise<NotebookCellGrade[]> {
  const preview = {
    before: before.notebook,
    after: after.notebook,
    diff: computeNotebookDiff(before.notebook, after.notebook, {
      matchCellIdsOnly: true,
    }),
  }
  const tasks = preview.diff.cells
    .filter((row) => row.kind !== 'unchanged' || row.moved)
    .map((row) => {
      const cellId = (row.compareCell ?? row.baseCell)!.refId
      return { cellId, input: prepareSuggestionInput(preview, cellId) }
    })
    .filter((task) => task.input.operations.length > 0)
  const results: NotebookCellGrade[] = new Array(tasks.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor++
      const { cellId, input } = tasks[index]
      if (signal?.aborted) {
        results[index] = {
          cellId,
          status: 'error',
          error: 'Grading cancelled; changes were already applied.',
        }
        continue
      }
      try {
        const prediction = await gradeSuggestion(input, signal)
        results[index] = { cellId, status: 'graded', ...prediction }
      } catch (error) {
        results[index] = {
          cellId,
          status: 'error',
          error:
            error instanceof Error ? error.message : 'Prediction unavailable',
        }
      }
    }
  }
  await Promise.all([worker(), worker()])
  return results
}
