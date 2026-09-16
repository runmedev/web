import type { TrainingExample } from './model'
import type { ExampleJob } from './protocol'

export interface ExampleSelection {
  examples: TrainingExample[]
  jobs: Record<string, ExampleJob>
}
const selections = new Map<string, ExampleSelection>()
const listeners = new Set<() => void>()

/** Ephemeral recipe selections. Never persisted to OPFS or sessionStorage. */
export function setExampleSelection(
  uri: string,
  selection: ExampleSelection
): void {
  selections.set(uri, structuredClone(selection))
  for (const listener of listeners) listener()
}
export function getExampleSelection(uri: string): ExampleSelection | undefined {
  return selections.get(uri)
}
export function subscribeExampleSelections(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
