import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { appLogger } from '../../lib/logging/runtime'
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  IncompleteGoogleDriveSearchError,
  listGoogleDriveChildren,
  listGoogleDriveRoots,
  searchGoogleDriveResources,
} from './googleDriveBrowser'
import type {
  GoogleDriveLocation,
  GoogleDriveResource,
} from './googleDriveBrowser'

export type GoogleDrivePickerMode = 'file' | 'folder'

export type PickedGoogleDriveResource = {
  id: string
  name: string
  mimeType?: string
  resourceKey?: string
}

type GoogleDriveResourcePickerDialogProps = {
  accessToken: string
  mode: GoogleDrivePickerMode
  onCancel: () => void
  onSelect: (resource: PickedGoogleDriveResource) => void
}

const ROOT_LIST_ERROR =
  "Runme could not list Google Drive locations. Verify that the Google Drive API is enabled for this credential's project and that the effective Drive identity can list Shared Drives."

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Browses My Drive and Shared Drives using the active Runme credential. The
 * breadcrumb stack is component state so navigation never changes auth state.
 */
export function GoogleDriveResourcePickerDialog({
  accessToken,
  mode,
  onCancel,
  onSelect,
}: GoogleDriveResourcePickerDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const requestIdRef = useRef(0)
  const [roots, setRoots] = useState<GoogleDriveLocation[]>([])
  const [breadcrumbs, setBreadcrumbs] = useState<GoogleDriveLocation[]>([])
  const [resources, setResources] = useState<GoogleDriveResource[]>([])
  const [selectedFile, setSelectedFile] = useState<GoogleDriveResource | null>(
    null
  )
  const [searchInput, setSearchInput] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  const currentLocation = breadcrumbs.at(-1)

  const loadRoots = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setErrorMessage('')
    setBreadcrumbs([])
    setRoots([])
    setResources([])
    setSelectedFile(null)
    setSearchInput('')
    setActiveSearch('')
    try {
      const nextRoots = await listGoogleDriveRoots(accessToken)
      if (requestId === requestIdRef.current) {
        setRoots(nextRoots)
      }
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return
      }
      appLogger.warn('Failed to list Drive locations in resource picker', {
        attrs: {
          scope: 'storage.drive.resource-picker',
          code: 'DRIVE_PICKER_ROOT_LIST_FAILED',
          error: String(error),
        },
      })
      setErrorMessage(ROOT_LIST_ERROR)
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }, [accessToken])

  const loadLocation = useCallback(
    async (
      location: GoogleDriveLocation,
      nextBreadcrumbs: GoogleDriveLocation[]
    ) => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      setErrorMessage('')
      setBreadcrumbs(nextBreadcrumbs)
      setResources([])
      setSelectedFile(null)
      setSearchInput('')
      setActiveSearch('')
      try {
        const nextResources = await listGoogleDriveChildren(
          accessToken,
          location
        )
        if (requestId === requestIdRef.current) {
          setResources(nextResources)
        }
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return
        }
        appLogger.warn('Failed to list folder in Drive resource picker', {
          attrs: {
            scope: 'storage.drive.resource-picker',
            code: 'DRIVE_PICKER_CHILD_LIST_FAILED',
            folderId: location.id,
            error: String(error),
          },
        })
        setErrorMessage(
          `Runme could not list items in ${location.name}. Verify that the effective Drive identity can access this folder, then retry.`
        )
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [accessToken]
  )

  const search = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim()
      if (!query) {
        void loadRoots()
        return
      }
      const requestId = ++requestIdRef.current
      setLoading(true)
      setErrorMessage('')
      setActiveSearch(query)
      setBreadcrumbs([])
      setResources([])
      setSelectedFile(null)
      try {
        const matches = await searchGoogleDriveResources(
          accessToken,
          query,
          mode
        )
        if (requestId === requestIdRef.current) {
          setResources(matches)
        }
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return
        }
        appLogger.warn('Failed to search Drive resource picker', {
          attrs: {
            scope: 'storage.drive.resource-picker',
            code: 'DRIVE_PICKER_SEARCH_FAILED',
            error: String(error),
          },
        })
        setErrorMessage(
          error instanceof IncompleteGoogleDriveSearchError
            ? 'Google Drive could not search every accessible Drive. Narrow the search text and retry.'
            : `Runme could not search Google Drive for “${query}”. Verify that the Google Drive API is enabled and the effective Drive identity can list resources, then retry.`
        )
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [accessToken, loadRoots, mode]
  )

  useEffect(() => {
    void loadRoots()
    return () => {
      requestIdRef.current += 1
    }
  }, [loadRoots])

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const dialog = dialogRef.current
    dialog?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel()
        return
      }
      if (event.key !== 'Tab' || !dialog) {
        return
      }

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter(
        (element) =>
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true'
      )
      const first = focusable.at(0)
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const active = document.activeElement
      if (
        event.shiftKey &&
        (active === first || active === dialog || !dialog.contains(active))
      ) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [onCancel])

  const visibleResources = resources.filter(
    (resource) =>
      mode === 'file' || resource.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE
  )

  const retry = () => {
    if (activeSearch) {
      void search(activeSearch)
      return
    }
    if (currentLocation) {
      void loadLocation(currentLocation, breadcrumbs)
      return
    }
    void loadRoots()
  }

  const selectCurrent = () => {
    if (mode === 'folder' && currentLocation) {
      onSelect({
        id: currentLocation.id,
        name: currentLocation.name,
        mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
        ...(currentLocation.resourceKey
          ? { resourceKey: currentLocation.resourceKey }
          : {}),
      })
      return
    }
    if (mode === 'file' && selectedFile) {
      onSelect(selectedFile)
    }
  }

  return createPortal(
    <div
      id="google-drive-resource-picker-overlay"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <section
        id="google-drive-resource-picker-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="google-drive-resource-picker-title"
        tabIndex={-1}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-nb-border bg-nb-surface text-nb-text shadow-2xl outline-none"
      >
        <header className="border-b border-nb-border px-5 py-4">
          <h2
            id="google-drive-resource-picker-title"
            className="text-lg font-semibold"
          >
            {mode === 'folder'
              ? 'Choose a Google Drive folder'
              : 'Choose a Google Drive file'}
          </h2>
          <form
            id="google-drive-resource-picker-search"
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void search(searchInput)
            }}
          >
            <label
              htmlFor="google-drive-resource-picker-search-input"
              className="sr-only"
            >
              Search Google Drive
            </label>
            <input
              id="google-drive-resource-picker-search-input"
              type="search"
              value={searchInput}
              placeholder={
                mode === 'folder'
                  ? 'Search folders in Google Drive'
                  : 'Search files in Google Drive'
              }
              className="min-w-0 flex-1 rounded-nb-sm border border-nb-border bg-nb-surface px-3 py-2 text-sm outline-none focus:border-nb-accent focus:ring-2 focus:ring-nb-accent-soft"
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button
              type="submit"
              className="btn"
              disabled={!searchInput.trim() || loading}
            >
              Search
            </button>
          </form>
          <nav
            id="google-drive-resource-picker-breadcrumbs"
            aria-label="Google Drive location"
            className="mt-2 flex min-h-7 items-center gap-1 overflow-x-auto text-sm"
          >
            <button
              type="button"
              className="rounded px-1.5 py-1 text-nb-accent hover:bg-nb-surface-2"
              onClick={() => void loadRoots()}
            >
              Drive locations
            </button>
            {activeSearch ? (
              <span className="flex items-center gap-1">
                <span aria-hidden="true" className="text-nb-text-muted">
                  /
                </span>
                <span aria-current="page" className="px-1.5 py-1">
                  Search results
                </span>
              </span>
            ) : null}
            {breadcrumbs.map((crumb, index) => (
              <span
                key={`${crumb.id}-${index}`}
                className="flex items-center gap-1"
              >
                <span aria-hidden="true" className="text-nb-text-muted">
                  /
                </span>
                <button
                  type="button"
                  aria-current={
                    index === breadcrumbs.length - 1 ? 'page' : undefined
                  }
                  className="whitespace-nowrap rounded px-1.5 py-1 hover:bg-nb-surface-2"
                  onClick={() =>
                    void loadLocation(crumb, breadcrumbs.slice(0, index + 1))
                  }
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
        </header>

        <div
          id="google-drive-resource-picker-content"
          className="min-h-64 flex-1 overflow-y-auto p-4"
        >
          {errorMessage ? (
            <div
              id="google-drive-resource-picker-error"
              role="alert"
              className="rounded-nb-sm border border-nb-error/40 bg-red-50 px-3 py-3 text-sm text-nb-error"
            >
              <p>{errorMessage}</p>
              <button type="button" className="btn mt-3" onClick={retry}>
                Retry
              </button>
            </div>
          ) : loading ? (
            <p
              role="status"
              className="py-12 text-center text-sm text-nb-text-muted"
            >
              Loading Google Drive…
            </p>
          ) : !currentLocation && !activeSearch ? (
            <div id="google-drive-resource-picker-roots" className="space-y-2">
              {roots.map((root) => (
                <button
                  key={root.id}
                  type="button"
                  aria-label={`Open ${root.name}`}
                  className="flex w-full items-center gap-3 rounded-nb-sm border border-nb-border bg-nb-surface-2 px-3 py-3 text-left hover:border-nb-border-strong hover:bg-nb-surface-3 focus:outline-none focus:ring-2 focus:ring-nb-accent-soft"
                  onClick={() => void loadLocation(root, [root])}
                >
                  <FolderIcon />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {root.name}
                  </span>
                  <span className="text-xs text-nb-text-muted">
                    {root.driveId ? 'Shared Drive' : 'Personal'}
                  </span>
                </button>
              ))}
            </div>
          ) : visibleResources.length === 0 ? (
            <p className="py-12 text-center text-sm text-nb-text-muted">
              {activeSearch
                ? `No matching ${mode === 'folder' ? 'folders' : 'files'} found.`
                : 'This folder is empty.'}
            </p>
          ) : (
            <div id="google-drive-resource-picker-items" className="space-y-2">
              {visibleResources.map((resource) => {
                const isFolder =
                  resource.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE
                const selected = selectedFile?.id === resource.id
                return (
                  <button
                    key={resource.id}
                    type="button"
                    aria-label={
                      isFolder
                        ? `Open folder ${resource.name}`
                        : `Select file ${resource.name}`
                    }
                    aria-pressed={isFolder ? undefined : selected}
                    className={`flex w-full items-center gap-3 rounded-nb-sm border px-3 py-3 text-left focus:outline-none focus:ring-2 focus:ring-nb-accent-soft ${
                      selected
                        ? 'border-nb-accent bg-nb-accent-muted'
                        : 'border-nb-border bg-nb-surface-2 hover:border-nb-border-strong hover:bg-nb-surface-3'
                    }`}
                    onClick={() => {
                      if (isFolder) {
                        void loadLocation(resource, [
                          ...(activeSearch ? [] : breadcrumbs),
                          resource,
                        ])
                      } else {
                        setSelectedFile(resource)
                      }
                    }}
                  >
                    {isFolder ? <FolderIcon /> : <FileIcon />}
                    <span className="min-w-0 flex-1 truncate">
                      {resource.name}
                    </span>
                    <span className="text-xs text-nb-text-muted">
                      {isFolder ? 'Folder' : 'File'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-nb-border px-5 py-4">
          <p className="min-w-0 truncate text-sm text-nb-text-muted">
            {mode === 'folder' && currentLocation
              ? `Selected folder: ${currentLocation.name}`
              : selectedFile
                ? `Selected file: ${selectedFile.name}`
                : activeSearch
                  ? `Search results for “${activeSearch}”`
                  : 'Choose a location to continue.'}
          </p>
          <div
            id="google-drive-resource-picker-footer-actions"
            className="flex shrink-0 gap-2"
          >
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded-nb-sm bg-nb-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                loading ||
                Boolean(errorMessage) ||
                (mode === 'folder' ? !currentLocation : !selectedFile)
              }
              onClick={selectCurrent}
            >
              {mode === 'folder' ? 'Select this folder' : 'Select file'}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  )
}

function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0 fill-current text-nb-accent"
    >
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0 fill-current text-nb-text-muted"
    >
      <path d="M6 2h7l5 5v15H6V2Zm7 1.5V8h4.5L13 3.5ZM8 12v2h8v-2H8Zm0 4v2h6v-2H8Z" />
    </svg>
  )
}
