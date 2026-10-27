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

/** Read loaded editors directly, without the worker, persistence, or browser storage. */
export function captureNotebookRecoveryDrafts(): RecoveryDraft[] {
  return openModels()
    .filter((model) => !model.isReadOnly())
    .map((model) => {
      const snapshot = model.getSnapshot()
      return {
        uri: snapshot.uri,
        name: snapshot.name,
        content: encodeRunmeNotebook(snapshot.notebook),
      }
    })
}

/** Save every editor before any asynchronous work. Session copies survive reload, not tab closure. */
export function backupNotebookRecoveryDrafts(): number {
  const copies = captureNotebookRecoveryDrafts()
  const drafts = readRecoveryDrafts()
  for (const draft of copies) {
    if (
      !drafts.some(
        (old) => old.uri === draft.uri && old.content === draft.content
      )
    )
      drafts.push(draft)
  }
  sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  return copies.length
}

/** Only loaded models contain editor contents; placeholders must not become empty recovery copies. */
function openModels() {
  const controller = getNotebookDataController()
  return controller
    .getOpenNotebooks()
    .map((entry) => controller.getNotebookData(entry.uri))
    .filter(
      (model): model is NonNullable<typeof model> =>
        model !== undefined && model.getSnapshot().loaded
    )
}

/** Freeze the editors while each tab acknowledges restart; all editable notebooks get tab-local recovery copies. */
export async function prepareNotebookStorageRestart(
  signal: AbortSignal = new AbortController().signal
): Promise<() => void> {
  signal.throwIfAborted()
  const models = openModels()
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
    // Copy all notebooks before a stalled first flush can block the rest.
    backupNotebookRecoveryDrafts()
    // Recovery must not wait on the persistence service being restarted. The
    // worker drains admitted writes in graceful mode; snapshots cover unsaved edits.
    signal.throwIfAborted()
    return release
  } catch (error) {
    release()
    throw new Error(
      `Could not preserve all editor copies; no automatic reload was performed. ${String(error)}`
    )
  }
}
