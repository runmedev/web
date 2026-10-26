import {
  CONTROL_DB,
  type Manifest,
  OWNER_LOCK,
  type Selection,
  readControl,
} from './control'
import {
  isUnreadableControl,
  quarantineControlDatabase,
} from './releaseDatabase'

/** Rebuild only unreadable release metadata, after independently fencing all
 * notebook writers and tabs. No timeout or heartbeat can evict a live owner.
 */
export async function recoverUnreadableControl(
  tabId: string,
  selection: Selection,
  candidate: Manifest
): Promise<void> {
  if (candidate.recoveredControlFormat !== 1)
    throw new Error(
      'This release predates release-settings recovery. Choose the latest stable release.'
    )
  await navigator.locks.request('runme-release-settings-repair', () =>
    navigator.locks.request(
      OWNER_LOCK,
      { ifAvailable: true },
      async (owner) => {
        if (!owner)
          throw new Error(
            'Save changes and close other Runme tabs before repairing release settings; a storage worker is still active.'
          )
        const locks = await navigator.locks.query()
        if (
          locks.held?.some(
            (lock) =>
              lock.name?.startsWith('runme-release-tab-') &&
              lock.name !== `runme-release-tab-${tabId}`
          )
        ) {
          throw new Error(
            'Save changes and close other Runme tabs on this site before repairing release settings.'
          )
        }
        try {
          await readControl()
          return
        } catch (error) {
          if (!isUnreadableControl(error)) throw error
        }
        // Avoid reusing an epoch/name from an unreadable previous installation.
        const epochBase =
          crypto.getRandomValues(new Uint32Array(1))[0] * 1048576
        await quarantineControlDatabase(CONTROL_DB, {
          format: 1,
          selection,
          candidate,
          tabs: {},
          epochBase,
          recoveredControlFormat: 1,
        })
      }
    )
  )
}
