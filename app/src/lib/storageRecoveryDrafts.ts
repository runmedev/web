import { getNotebookDataController } from './notebookDataController'
import { encodeRunmeNotebook } from './notebookFormat'

const DRAFTS_KEY = 'runme/storage-recovery-drafts/v1'
export type RecoveryDraft = { uri: string; name: string; content: string }

/** Recovery copies are separate from the operation log; never silently overwrite a newer revision. */
export function readRecoveryDrafts(): RecoveryDraft[] {
  const raw = sessionStorage.getItem(DRAFTS_KEY)
  return raw ? JSON.parse(raw) : []
}

/** Freeze the editors while each tab acknowledges restart; all editable notebooks get durable recovery copies. */
export async function prepareNotebookStorageRestart(): Promise<() => void> {
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
  const release = () =>
    models.forEach((model) => model!.setReleasePending(false))
  try {
    for (const model of models) {
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
        await model!.flushPendingPersist()
      } catch {
        /* The recovery copy remains available after reload. */
      }
    }
    return release
  } catch (error) {
    release()
    throw new Error(
      `Could not preserve editor copies; no tabs were reloaded. ${String(error)}`
    )
  }
}
