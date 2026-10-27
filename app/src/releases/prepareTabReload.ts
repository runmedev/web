import { getAppConsoleData } from '../lib/appConsole/appConsoleController'
import { getNotebookDataController } from '../lib/notebookDataController'
import {
  checkpointEditorSessions,
  checkpointEditorUris,
  resumeCheckpointTransport,
} from '../storage/tabRecoveryCheckpoint'
import { assertNoUpgradeBlockers, setReleasePreparation } from './runtime'

/** Bound a local preservation step without interpreting silence as data loss. */
async function preserveWithinDeadline<T>(
  work: Promise<T>,
  abort: AbortController
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            'This tab’s recovery backup timed out; no reload performed. Keep it open and retry or export edits.'
          )
          abort.abort(error)
          reject(error)
        }, 15_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Preserve only this tab. A broken worker cannot block replayable editor saves
 * from being checkpointed; unknown external effects still block a local reload.
 */
export async function prepareTabReload(): Promise<void> {
  assertNoUpgradeBlockers(true)
  const controller = getNotebookDataController()
  const entries = controller.getOpenNotebooks()
  if (
    entries.some(
      (entry) => entry.state === 'loading' || entry.state === 'resolving'
    )
  )
    throw new Error(
      'Wait for this tab’s notebooks to finish loading before reloading'
    )
  const models = entries
    .map((entry) => controller.getNotebookData(entry.uri))
    .filter((model) => model?.getSnapshot().loaded)
  if (
    models.some(
      (model) =>
        model!.hasActiveExecutions() ||
        model!.isReviewPending() ||
        model!.isReleasePending()
    )
  )
    throw new Error(
      'Stop running cells and finish reviews in this tab before reloading'
    )
  const consoleData = getAppConsoleData()
  setReleasePreparation(true)
  models.forEach((model) => model!.setReleasePending(true))
  const abort = new AbortController()
  try {
    const replayable = checkpointEditorUris()
    // Legacy JSON/Markdown editors have no operation IDs to replay safely.
    // Flush those through a healthy worker; failure blocks only this tab.
    for (const model of models)
      if (!model!.isReadOnly() && !replayable.has(model!.getUri()))
        await preserveWithinDeadline(model!.flushPendingPersist(), abort)
    // Console persistence is independent of the notebook worker. Failure keeps
    // this tab open, and cannot hold up another tab's worker activation.
    await preserveWithinDeadline(
      consoleData.flushForRelease(abort.signal),
      abort
    )
    const editors = new Map(
      models
        .filter(
          (model) => !model!.isReadOnly() && replayable.has(model!.getUri())
        )
        .map((model) => [model!.getUri(), model!.getSnapshot().notebook])
    )
    const captured = await preserveWithinDeadline(
      checkpointEditorSessions(editors, abort.signal),
      abort
    )
    if ([...editors.keys()].some((uri) => !captured.has(uri)))
      throw new Error(
        'This tab has an editor without replayable save recovery; save or export it before reloading'
      )
    assertNoUpgradeBlockers(true)
  } catch (error) {
    resumeCheckpointTransport()
    consoleData.resumeAfterFailedPreparation()
    models.forEach((model) => model!.setReleasePending(false))
    setReleasePreparation(false)
    throw error
  }
}
