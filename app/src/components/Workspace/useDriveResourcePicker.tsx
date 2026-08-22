import { ReactNode, useCallback, useState } from 'react'

import { appState } from '../../lib/runtime/AppState'
import { driveFileUrl, driveFolderUrl } from '../../storage/drive'
import {
  GoogleDriveResourcePickerDialog,
  GoogleDrivePickerMode,
  PickedGoogleDriveResource,
} from './GoogleDriveResourcePickerDialog'

export type PickedDriveResource = {
  uri: string
  name: string
  mimeType?: string
}

type PendingPicker = {
  accessToken: string
  mode: GoogleDrivePickerMode
  resolve: (resource: PickedDriveResource | null) => void
}

/**
 * Converts the modal picker's callback lifecycle into promises used by
 * notebook attachment flows. Only one pending picker is retained at a time.
 */
export function useDriveResourcePicker(): {
  pickDriveFile: () => Promise<PickedDriveResource | null>
  pickDriveFolder: () => Promise<PickedDriveResource | null>
  driveResourcePickerDialog: ReactNode
} {
  const [pending, setPending] = useState<PendingPicker | null>(null)

  const pick = useCallback(
    async (
      mode: GoogleDrivePickerMode
    ): Promise<PickedDriveResource | null> => {
      const driveStore = appState.driveNotebookStore
      if (!driveStore) {
        throw new Error('Google Drive storage is not initialized.')
      }
      const accessToken = await driveStore.getAccessToken({ interactive: true })
      return new Promise((resolve) => {
        setPending({ accessToken, mode, resolve })
      })
    },
    []
  )

  const cancel = useCallback(() => {
    setPending((current) => {
      current?.resolve(null)
      return null
    })
  }, [])

  const select = useCallback((resource: PickedGoogleDriveResource) => {
    setPending((current) => {
      if (!current) {
        return null
      }
      current.resolve({
        uri:
          current.mode === 'folder'
            ? driveFolderUrl(resource.id)
            : driveFileUrl(resource.id),
        name: resource.name,
        mimeType: resource.mimeType,
      })
      return null
    })
  }, [])

  const driveResourcePickerDialog = pending ? (
    <GoogleDriveResourcePickerDialog
      accessToken={pending.accessToken}
      mode={pending.mode}
      onCancel={cancel}
      onSelect={select}
    />
  ) : null

  return {
    pickDriveFile: () => pick('file'),
    pickDriveFolder: () => pick('folder'),
    driveResourcePickerDialog,
  }
}
