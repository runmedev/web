import { ReactNode, useCallback, useState } from 'react'

import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import { useNotebookStore } from '../../contexts/NotebookStoreContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { appLogger } from '../../lib/logging/runtime'
import { markOnboardingTaskComplete } from '../../lib/onboarding'
import { tourUiController } from '../../lib/tourUiController'
import { driveFolderUrl } from '../../storage/drive'
import { GoogleDriveResourcePickerDialog } from './GoogleDriveResourcePickerDialog'
import type { PickedGoogleDriveResource } from './GoogleDriveResourcePickerDialog'

interface GoogleDrivePickerButtonProps {
  label?: string
  title?: string
  className?: string
  children?: ReactNode
}

/**
 * Opens Runme's Drive browser and mounts the selected folder in Explorer. The
 * picker token lives only in component state for the lifetime of the dialog.
 */
export function GoogleDrivePickerButton({
  label = 'Choose Folder',
  title,
  className,
  children,
}: GoogleDrivePickerButtonProps) {
  const { ensureAccessToken } = useGoogleAuth()
  const { addItem, getItems } = useWorkspace()
  const { store } = useNotebookStore()
  const [pickerAccessToken, setPickerAccessToken] = useState('')
  const [mountError, setMountError] = useState('')

  const mountFolder = useCallback(
    async (folderId: string, folderName: string) => {
      if (!store) {
        appLogger.error('Notebook store is unavailable for a Drive folder', {
          attrs: {
            scope: 'storage.drive.resource-picker',
            code: 'DRIVE_FOLDER_STORE_UNAVAILABLE',
          },
        })
        setMountError('Runme storage is not ready. Reload the page and retry.')
        return
      }

      try {
        const localUri = await store.updateFolder(
          driveFolderUrl(folderId),
          folderName
        )
        if (!getItems().includes(localUri)) {
          addItem(localUri)
        }
        markOnboardingTaskComplete('add-drive-folder')
        tourUiController.recordGoogleDriveFolderAdded()
      } catch (error) {
        appLogger.error('Failed to mirror Drive folder', {
          attrs: {
            scope: 'storage.drive.resource-picker',
            code: 'DRIVE_FOLDER_MIRROR_FAILED',
            error: String(error),
          },
        })
        setMountError(
          'Runme could not add this folder. Verify that the effective Drive identity can read it, then retry.'
        )
      }
    },
    [addItem, getItems, store]
  )

  const handleOpenPicker = useCallback(() => {
    setMountError('')
    void (async () => {
      try {
        const accessToken = await ensureAccessToken({ interactive: true })
        if (accessToken) {
          setPickerAccessToken(accessToken)
        }
      } catch (error) {
        appLogger.error('Failed to authorize Google Drive browser', {
          attrs: {
            scope: 'storage.drive.resource-picker',
            code: 'DRIVE_PICKER_AUTH_FAILED',
            error: String(error),
          },
        })
        setMountError(
          'Runme could not authorize Google Drive. Check the configured credential and retry.'
        )
      }
    })()
  }, [ensureAccessToken])

  const closePicker = useCallback(() => {
    setPickerAccessToken('')
  }, [])

  const handleSelect = useCallback(
    (resource: PickedGoogleDriveResource) => {
      closePicker()
      void mountFolder(resource.id, resource.name)
    },
    [closePicker, mountFolder]
  )

  return (
    <>
      <button
        type="button"
        data-tour-id="explorer.add-google-drive-folder"
        className={`btn flex items-center gap-2 ${className ?? ''}`}
        onClick={handleOpenPicker}
        aria-label={label}
        title={title ?? label}
      >
        {children ? (
          children
        ) : (
          <>
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 48 48"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M25.26 5.55a3 3 0 0 0-2.52 0L9.48 12.09a2.5 2.5 0 0 0-1.41 1.8L5.25 27.31a2.5 2.5 0 0 0 .24 1.56l6.96 14.31a2.5 2.5 0 0 0 2.23 1.4h18.64a2.5 2.5 0 0 0 2.23-1.4l6.96-14.31c.24-.48.3-1.04.24-1.56l-2.82-13.42a2.5 2.5 0 0 0-1.41-1.8L25.26 5.55Z"
                fill="#188038"
              />
              <path
                d="m25.26 5.55-.04.02 13 6.52a2.5 2.5 0 0 1 1.41 1.8l2.82 13.42a2.5 2.5 0 0 1-.24 1.56l-6.96 14.31a2.5 2.5 0 0 1-2.23 1.4H24V5a3 3 0 0 1 1.26.55Z"
                fill="#1967D2"
              />
              <path
                d="M24 5v43.56h-9.32a2.5 2.5 0 0 1-2.23-1.4L5.5 31.44a2.5 2.5 0 0 1-.24-1.56l2.82-13.42a2.5 2.5 0 0 1 1.41-1.8l13-6.52.04-.02Z"
                fill="#FBBC04"
              />
              <path
                d="M5.26 28.87c.06.15.12.3.2.44l6.96 14.31a2.5 2.5 0 0 0 2.23 1.4h18.64a2.5 2.5 0 0 0 2.23-1.4l6.96-14.31c.08-.15.14-.29.2-.44L24 26.3 5.26 28.87Z"
                fill="#34A853"
              />
              <path
                d="M24 26.3V44c0 .85.95 1.33 1.68.84l17.82-12.04c.48-.32.66-.94.52-1.49L42.4 26.3H24Z"
                fill="#4285F4"
              />
              <path
                d="M24 26.3H5.6l-1.62 5.02a1.51 1.51 0 0 0 .5 1.67L22.9 44.84c.73.5 1.68.01 1.68-.84V26.3Z"
                fill="#EA4335"
              />
            </svg>
            <span>{label}</span>
          </>
        )}
      </button>
      {mountError ? (
        <p role="alert" className="mt-2 max-w-md text-sm text-nb-error">
          {mountError}
        </p>
      ) : null}
      {pickerAccessToken ? (
        <GoogleDriveResourcePickerDialog
          accessToken={pickerAccessToken}
          mode="folder"
          onCancel={closePicker}
          onSelect={handleSelect}
        />
      ) : null}
    </>
  )
}

export default GoogleDrivePickerButton
