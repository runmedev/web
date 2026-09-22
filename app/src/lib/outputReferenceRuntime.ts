import { RunmeMetadataKey } from '../runme/client'
import type LocalNotebooks from '../storage/local'
import type { NotebookDataLike } from './runtime/runmeConsole'

export type OutputReferenceStore = Pick<
  LocalNotebooks,
  'createOutputReference' | 'resolveOutputReference'
>

/** Shared UI/API action: persist pending autosave and pin exactly the visible output. */
export async function outputReferenceSource(
  store: OutputReferenceStore,
  notebook: NotebookDataLike,
  cellId: string,
  outputIndex: number,
  itemIndex: number
): Promise<string> {
  const cell = notebook
    .getNotebook()
    .cells.find((cell) => cell.refId === cellId)
  const expected = cell?.outputs[outputIndex]?.items[itemIndex]
  if (!expected) throw new Error('Select an existing output item.')
  const expectedBytes = new Uint8Array(expected.data)
  const expectedRun = cell?.metadata[RunmeMetadataKey.LastRunID]
  if (!notebook.flushPendingPersist)
    throw new Error('Notebook autosave is unavailable.')
  await notebook.flushPendingPersist()
  const source = await store.createOutputReference(
    notebook.getUri(),
    cellId,
    outputIndex,
    itemIndex
  )
  const resolved = await store.resolveOutputReference(notebook.getUri(), source)
  if (
    resolved.item.mime !== expected.mime ||
    resolved.item.data.length !== expectedBytes.length ||
    resolved.item.data.some((byte, index) => byte !== expectedBytes[index]) ||
    (expectedRun && resolved.executionId !== expectedRun)
  ) {
    throw new Error(
      'The output changed while copying. Copy the desired output again.'
    )
  }
  return source
}
