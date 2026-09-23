import { appLogger } from '../lib/logging/runtime'
import { appState } from '../lib/runtime/AppState'
import { DriveNotebookStore } from './drive'
import { FilesystemNotebookStore } from './fs'
import LocalNotebooks from './local'
import { OwnerCommitQueue } from './ownerCommitQueue'
import { StorageOwnerHost } from './storageOwnerHost'

// The stable worker URL/name keeps all compatible tabs on this owner. The
// versioned handshake rejects incompatible clients rather than adding a writer.
let host: StorageOwnerHost
const drive = new DriveNotebookStore((options) => host.accessToken(options))
const networkCoordination = new OwnerCommitQueue()
const store = new LocalNotebooks(
  drive,
  undefined,
  undefined,
  undefined,
  { runExclusive: (key, operation) => networkCoordination.run(key, operation) },
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
host = new StorageOwnerHost(store)
;(
  globalThis as unknown as { onconnect: (event: MessageEvent) => void }
).onconnect = (event) => host.attach(event.ports[0])
setInterval(
  () =>
    void host.rescan().catch((error) =>
      appLogger.warn('Storage owner rescan failed', {
        attrs: { scope: 'storage.owner', error: String(error) },
      })
    ),
  120_000
)
