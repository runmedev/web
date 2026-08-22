import { useCallback } from 'react'
import useDrivePicker from 'react-google-drive-picker'

import { DRIVE_SCOPES } from '../../contexts/GoogleAuthContext'
import { googleClientManager } from '../../lib/googleClientManager'
import { appState } from '../../lib/runtime/AppState'
import { driveFileUrl, driveFolderUrl } from '../../storage/drive'
import { getGoogleDrivePickerViews } from './googleDrivePickerViews'

type PickerDocument = {
  id: string
  name?: string
  mimeType?: string
}

type PickerCallbackData = {
  action: string
  docs?: PickerDocument[]
}

export type PickedDriveResource = {
  uri: string
  name: string
  mimeType?: string
}

export function useDriveResourcePicker() {
  const [openPicker] = useDrivePicker()

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
      const customViews = await getGoogleDrivePickerViews(kind)
      return new Promise((resolve) => {
        openPicker({
          token,
          appId,
          clientId,
          developerKey,
          viewId: kind === 'folder' ? 'FOLDERS' : 'DOCS',
          disableDefaultView: true,
          customViews,
          customScopes: DRIVE_SCOPES,
          showUploadView: false,
          showUploadFolders: false,
          multiselect: false,
          callbackFunction: (data: PickerCallbackData) => {
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
        })
      })
    },
    [openPicker]
  )

  return {
    pickDriveFile: () => pick('file'),
    pickDriveFolder: () => pick('folder'),
  }
}
