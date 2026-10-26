import {
  type Manifest,
  type ReleaseProgress,
  type Selection,
  control,
  discover,
  stage,
} from './control'
import { ReleaseControlError } from './releaseDatabase'

/** Discover and cache the fallback independently of release-settings reads.
 * Never swap coordination databases or manufacture an active epoch: the real
 * control transaction must recover before an existing owner can be replaced.
 */
export async function prepareStartupRecovery(
  selection: Selection = { kind: 'channel', name: 'stable' },
  progress?: (value: ReleaseProgress) => void,
  scope: 'all' | 'startup' = 'all'
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
      if (!(error instanceof ReleaseControlError) || attempt === 1) throw error
    }
  }
}
