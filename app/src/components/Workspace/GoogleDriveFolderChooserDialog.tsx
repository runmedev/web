import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import type { GoogleSharedDrive } from './googleSharedDrives'

type GoogleDriveFolderChooserDialogProps = {
  drives: GoogleSharedDrive[]
  errorMessage?: string
  onBrowseFolders: () => void
  onCancel: () => void
  onSelectSharedDrive: (drive: GoogleSharedDrive) => void
}

/**
 * Adds the Shared Drive root selection that Google Picker does not expose.
 * Picker remains available for My Drive and folders inside a Shared Drive.
 */
export function GoogleDriveFolderChooserDialog({
  drives,
  errorMessage,
  onBrowseFolders,
  onCancel,
  onSelectSharedDrive,
}: GoogleDriveFolderChooserDialogProps) {
  const firstDriveRef = useRef<HTMLButtonElement | null>(null)
  const browseButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const initialFocus = firstDriveRef.current ?? browseButtonRef.current
    initialFocus?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return createPortal(
    <div
      id="google-drive-folder-chooser-overlay"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <section
        id="google-drive-folder-chooser-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="google-drive-folder-chooser-title"
        className="w-full max-w-lg rounded-xl border border-nb-border bg-nb-surface p-5 text-nb-text shadow-2xl"
      >
        <h2
          id="google-drive-folder-chooser-title"
          className="text-lg font-semibold"
        >
          Choose a Google Drive folder
        </h2>
        <p className="mt-2 text-sm leading-6 text-nb-text-muted">
          Select a Shared Drive root, or browse Google Drive to choose My Drive
          or a folder inside a Shared Drive.
        </p>

        {errorMessage ? (
          <p
            id="google-drive-folder-chooser-error"
            role="alert"
            className="mt-4 rounded-nb-sm border border-nb-error/40 bg-red-50 px-3 py-2 text-sm text-nb-error"
          >
            {errorMessage}
          </p>
        ) : null}

        {drives.length > 0 ? (
          <div
            id="google-drive-folder-chooser-shared-drives"
            className="mt-4 max-h-72 space-y-2 overflow-y-auto"
          >
            {drives.map((drive, index) => (
              <button
                key={drive.id}
                ref={index === 0 ? firstDriveRef : undefined}
                type="button"
                className="flex w-full items-center gap-3 rounded-nb-sm border border-nb-border bg-nb-surface-2 px-3 py-3 text-left hover:border-nb-border-strong hover:bg-nb-surface-3 focus:outline-none focus:ring-2 focus:ring-nb-accent-soft"
                onClick={() => onSelectSharedDrive(drive)}
                aria-label={`Select ${drive.name} Shared Drive root`}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-5 w-5 shrink-0 fill-current text-nb-accent"
                >
                  <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z" />
                </svg>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {drive.name}
                </span>
                <span className="text-xs text-nb-text-muted">
                  Shared Drive
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={browseButtonRef}
            type="button"
            className="rounded-nb-sm bg-nb-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            onClick={onBrowseFolders}
          >
            Browse folders…
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
