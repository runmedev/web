import { appLogger } from '../lib/logging/runtime'
import { appState } from '../lib/runtime/AppState'
import { RELEASE_CAPABILITIES, readControl } from '../releases/control'
import { closeReleaseDatabases } from '../releases/databases'
import { DriveNotebookStore } from './drive'
import { FilesystemNotebookStore } from './fs'
import LocalNotebooks from './local'
import { OwnerCommitQueue } from './ownerCommitQueue'
import { StorageOwnerHost } from './storageOwnerHost'

/** Construct storage only under the wrapper's lifetime lock. */
export async function startStorageOwner(identity?: {
  releaseId: string
  epoch: number
}) {
  // eslint-disable-next-line prefer-const
  let host: StorageOwnerHost
  const drive = new DriveNotebookStore((options) => host.accessToken(options))
  const networkCoordination = new OwnerCommitQueue()
  const store = new LocalNotebooks(
    drive,
    undefined,
    undefined,
    undefined,
    {
      runExclusive: (key, operation) => networkCoordination.run(key, operation),
    },
    undefined,
    undefined,
    {
      owner: true,
      onChange: (uri) => host?.notify(uri),
      onEvent: (type, detail) => host?.event(type, detail),
    }
  )
  store.setFilesystemStore(new FilesystemNotebookStore())
  store.setDriveSyncAvailable(false)
  appState.setDriveNotebookStore(drive)
  appState.setLocalNotebooks(store)
  host = new StorageOwnerHost(
    store,
    () => {
      store.close()
      closeReleaseDatabases()
      ;(globalThis as unknown as { close(): void }).close()
    },
    identity
      ? async (request) => {
          const state = await readControl()
          const tab = request.tabId && state.tabs[request.tabId]
          if (
            request.epoch !== identity.epoch ||
            !tab ||
            tab.epoch !== identity.epoch ||
            state.active?.epoch !== identity.epoch ||
            state.active.manifest.releaseId !== identity.releaseId ||
            state.transition?.phase === 'handoff' ||
            (request.tabId &&
              state.transition?.participants[request.tabId]?.ready)
          )
            throw new Error(
              'Stale or frozen release: storage request rejected before effects'
            )
        }
      : undefined,
    identity ? { ...identity, capabilities: RELEASE_CAPABILITIES } : undefined
  )
  const timer = setInterval(
    () =>
      void host.rescan().catch((error) =>
        appLogger.warn('Storage owner rescan failed', {
          attrs: { scope: 'storage.owner', error: String(error) },
        })
      ),
    120_000
  )

  try {
    await store.ready
  } catch (error) {
    clearInterval(timer)
    await store.drainForStorageRestart()
    store.close()
    throw error
  }
  return {
    attach: (port: MessagePort) => host.attach(port),
    drain: () => {
      clearInterval(timer)
      return host.drainForRelease()
    },
    close: () => {
      clearInterval(timer)
      store.close()
      closeReleaseDatabases()
    },
  }
}
