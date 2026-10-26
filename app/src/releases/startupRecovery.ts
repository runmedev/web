import {
  type Manifest,
  type ReleaseProgress,
  type Selection,
  control,
  discover,
  stage,
} from './control'
import { ReleaseControlError, isUnreadableControl } from './releaseDatabase'

/** Discover and cache the fallback independently of release-settings reads.
 * Transient failures retry the same state. Only an explicitly fenced repair
 * callback may quarantine an irrecoverable record after download verification.
 */
export async function prepareStartupRecovery(
  selection: Selection = { kind: 'channel', name: 'stable' },
  progress?: (value: ReleaseProgress) => void,
  scope: 'all' | 'startup' = 'all',
  repair?: (candidate: Manifest) => Promise<void>
): Promise<Manifest> {
  const candidate = await discover(selection)
  await navigator.locks.request('runme-release-cache', { mode: 'shared' }, () =>
    stage(candidate, progress, scope)
  )
  // A transient error can clear while downloading. Retry a second bounded
  // transaction, always rereading state so a prior uncertain commit is safe.
  for (let attempt = 0; ; attempt++) {
    try {
      await control((state) => {
        state.selection = selection
        state.candidate = candidate
      })
      return candidate
    } catch (error) {
      if (attempt === 1 && repair && isUnreadableControl(error)) {
        await repair(candidate)
        return candidate
      }
      if (!(error instanceof ReleaseControlError) || attempt === 1) throw error
    }
  }
}
