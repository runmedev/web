import { getNotebookDataController } from './notebookDataController'
import { encodeRunmeNotebook } from './notebookFormat'

const DRAFTS_KEY = 'runme/storage-recovery-drafts/v1'
export type RecoveryDraft = { uri: string; name: string; content: string }

/** Recovery copies are separate from the operation log; never silently overwrite a newer revision. */
export function readRecoveryDrafts(): RecoveryDraft[] {
  const raw = sessionStorage.getItem(DRAFTS_KEY)
  if (!raw) return []
  const drafts: unknown = JSON.parse(raw)
  if (
    !Array.isArray(drafts) ||
    drafts.some(
      (draft) =>
        !draft ||
        typeof draft !== 'object' ||
        typeof draft.uri !== 'string' ||
        typeof draft.name !== 'string' ||
        typeof draft.content !== 'string'
    )
  )
    throw new Error(
      'Stored recovery copies are malformed; their original bytes have been retained.'
    )
  return drafts
}

/** Freeze the editors while each tab acknowledges restart; all editable notebooks get durable recovery copies. */
export async function prepareNotebookStorageRestart(
  signal: AbortSignal = new AbortController().signal
): Promise<() => void> {
  signal.throwIfAborted()
  const controller = getNotebookDataController()
  const models = controller
    .getOpenNotebooks()
    .map((entry) => controller.getNotebookData(entry.uri))
    .filter((model) => model?.getSnapshot().loaded)
  if (
    models.some(
      (model) =>
        model!.hasActiveExecutions() ||
        model!.isReleasePending() ||
        model!.isReviewPending()
    )
  )
    throw new Error(
      'Stop running cells and finish notebook reviews before restarting Runme.'
    )
  models.forEach((model) => model!.setReleasePending(true))
  let released = false
  const release = () => {
    // An old flush may settle after a new recovery round acquires these editors.
    // Releasing twice would unlock the new round before its snapshot is safe.
    if (released) return
    released = true
    signal.removeEventListener('abort', release)
    models.forEach((model) => model!.setReleasePending(false))
  }
  signal.addEventListener('abort', release, { once: true })
  try {
    for (const model of models) {
      signal.throwIfAborted()
      if (model!.isReadOnly()) continue
      const snapshot = model!.getSnapshot()
      const draft = {
        uri: snapshot.uri,
        name: snapshot.name,
        content: encodeRunmeNotebook(snapshot.notebook),
      }
      const drafts = readRecoveryDrafts()
      if (
        !drafts.some(
          (old) => old.uri === draft.uri && old.content === draft.content
        )
      ) {
        // Persist first, even if the normal store is absent or its version rejects saves.
        sessionStorage.setItem(DRAFTS_KEY, JSON.stringify([...drafts, draft]))
      }
      try {
        await waitForPersist(model!.flushPendingPersist(), signal)
      } catch {
        /* The recovery copy remains available after reload. */
      }
      signal.throwIfAborted()
    }
    return release
  } catch (error) {
    release()
    throw new Error(
      `Could not preserve editor copies; no tabs were reloaded. ${String(error)}`
    )
  }
}

/** Cancel waiting, not the underlying commit. The owner still drains active writes. */
async function waitForPersist(
  persist: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([persist, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
