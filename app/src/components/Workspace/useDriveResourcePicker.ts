import { useCallback } from 'react'

import { googleClientManager } from '../../lib/googleClientManager'
import { appState } from '../../lib/runtime/AppState'
import { driveFileUrl, driveFolderUrl } from '../../storage/drive'
import { openGoogleDrivePicker } from './googleDrivePickerViews'

export type PickedDriveResource = {
  uri: string
  name: string
  mimeType?: string
}

export function useDriveResourcePicker() {
  const pick = useCallback(
    async (kind: 'file' | 'folder'): Promise<PickedDriveResource | null> => {
      const { clientId, developerKey, appId } =
        googleClientManager.getDrivePickerConfig()
      if (!clientId) {
        throw new Error(
          'Google Drive picker is not configured. Set a Google OAuth client ID first.'
        )
      }
      const driveStore = appState.driveNotebookStore
      if (!driveStore) {
        throw new Error('Google Drive storage is not initialized.')
      }
      const token = await driveStore.getAccessToken({ interactive: true })
      return new Promise((resolve, reject) => {
        void openGoogleDrivePicker({
          token,
          appId,
          developerKey,
          kind,
          callback: (data) => {
            const selected = data.action === 'picked' ? data.docs?.[0] : null
            if (!selected?.id) {
              resolve(null)
              return
            }
            resolve({
              uri:
                kind === 'folder'
                  ? driveFolderUrl(selected.id)
                  : driveFileUrl(selected.id),
              name: selected.name ?? selected.id,
              mimeType: selected.mimeType,
            })
          },
        }).catch(reject)
      })
    },
    []
  )

  return {
    pickDriveFile: () => pick('file'),
    pickDriveFolder: () => pick('folder'),
  }
}
