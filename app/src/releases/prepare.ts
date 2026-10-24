import { getAppConsoleData } from '../lib/appConsole/appConsoleController'
import { getNotebookDataController } from '../lib/notebookDataController'
import type { CommitReference } from './control'
import { closeReleaseDatabases } from './databases'
import { assertNoUpgradeBlockers, setReleasePreparation } from './runtime'

let frozen = false
/** Routine activation requires durable commits. Emergency sessionStorage copies
 * are intentionally not involved. Failed/uncertain saves keep this tab open.
 */
export async function prepareRelease(): Promise<CommitReference[]> {
  if (frozen)
    throw new Error(
      'This tab already prepared an upgrade; resume its pending transition'
    )
  assertNoUpgradeBlockers()
  const controller = getNotebookDataController()
  const entries = controller.getOpenNotebooks()
  if (
    entries.some(
      (entry) => entry.state === 'loading' || entry.state === 'resolving'
    )
  )
    throw new Error('Wait for notebooks to finish loading before upgrading')
  const models = controller
    .getOpenNotebooks()
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
    throw new Error('Stop running cells and finish reviews before upgrading')
  const consoleData = getAppConsoleData()
  if (consoleData.getSnapshot().cells.some((cell) => cell.status === 'running'))
    throw new Error('Stop running App Console cells before upgrading')
  setReleasePreparation(true)
  models.forEach((model) => model!.setReleasePending(true))
  try {
    for (const model of models)
      if (!model!.isReadOnly()) await model!.flushPendingPersist()
    await consoleData.flushForRelease()
    assertNoUpgradeBlockers()
    const refs = models.map((model) => ({
      uri: model!.getSnapshot().uri,
      heads: model!.getObservedOperationHeads() ?? [],
    }))
    // No schema-changing release is eligible yet. Still close every Dexie reader
    // after saves so future compatibility contracts cannot inherit blockers.
    closeReleaseDatabases()
    frozen = true
    return refs
  } catch (error) {
    consoleData.resumeAfterFailedPreparation()
    setReleasePreparation(false)
    models.forEach((model) => model!.setReleasePending(false))
    throw error
  }
}
