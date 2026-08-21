import {
  ChatBubbleLeftIcon,
  BookOpenIcon,
  CommandLineIcon,
  FolderIcon,
  DocumentTextIcon,
  InformationCircleIcon,
  Bars3BottomLeftIcon,
  QueueListIcon,
  ServerStackIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline'
import { XMarkIcon } from '@heroicons/react/20/solid'
import { CloudIcon as CloudSolidIcon } from '@heroicons/react/24/solid'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react'

import NotebookOutlinePanel from './NotebookOutlinePanel'
import WorkspaceExplorer from '../Workspace/WorkspaceExplorer'
import DocumentationExplorer from '../Documentation/DocumentationExplorer'
import {
  getBrowserAdapter,
  useBrowserAuthData,
} from '../../browserAdapter.client'
import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useRunners } from '../../contexts/RunnersContext'
import { useSidePanel } from '../../contexts/SidePanelContext'
import { useCommentsPanel } from '../../contexts/CommentsPanelContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import {
  isDriveLinkStatusUri,
  isDriveSyncStatusUri,
  isDocumentationDocumentUri,
  DRIVE_SYNC_STATUS_DOCUMENT_URI,
  isExcalidrawWorkspaceDocument,
  isNotebookDiffUri,
  isNotebookDocumentUri,
  isVersionInfoUri,
  VERSION_INFO_DOCUMENT_URI,
  isRunnerStatusUri,
  RUNNER_STATUS_DOCUMENT_URI,
  isAppConsoleUri,
  APP_CONSOLE_DOCUMENT_URI,
  isLogsUri,
  LOGS_DOCUMENT_URI,
} from '../../lib/workspaceDocuments/workspaceDocumentTypes'
import {
  readAppLoginConfiguration,
  saveAppLoginConfiguration,
  type AppLoginConfiguration,
} from '../../auth/appLoginConfiguration'
import LoginConfigurationDialog from '../AuthStatus/LoginConfigurationDialog'

const sideButtonBase = 'group side-btn'

const sideButtonInactive = 'side-btn-inactive'

const sideButtonActive = 'side-btn-active'

const tooltipBase = 'side-tooltip'

function getNotebookDisplayName(uri: string, name?: string): string {
  return name || uri.split('/').filter(Boolean).pop() || uri
}

function getNotebookStatusLabel(
  state?: string,
  readOnly?: boolean
): string | null {
  if (readOnly) {
    return 'Read-only'
  }
  if (state === 'blocked') {
    return 'Blocked'
  }
  if (state === 'error') {
    return 'Error'
  }
  if (state === 'loading' || state === 'resolving') {
    return 'Loading'
  }
  return null
}

/**
 * OpenDocumentsPanel renders a lightweight "open editors" style list driven by
 * WorkspaceDocumentContext. It shares the same open-document state as the tab strip so
 * the sidebar remains a secondary view over the exact same source of truth.
 * Status labels come from OpenNotebookEntry metadata; blocked entries do not
 * have editable NotebookData models in this tab.
 */
function OpenDocumentsPanel() {
  const { useWorkspaceDocuments, closeWorkspaceDocument } =
    useWorkspaceDocumentContext()
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()
  const openDocuments = useWorkspaceDocuments()
  const currentDocUri = getCurrentDoc()

  const handleCloseDocument = useCallback(
    (uri: string) => {
      closeWorkspaceDocument(uri)
    },
    [closeWorkspaceDocument]
  )

  return (
    <div
      id="open-documents-panel"
      className="flex h-full min-h-0 w-full flex-col bg-nb-surface"
    >
      <div
        id="open-documents-panel-header"
        className="border-b border-nb-border px-4 py-3"
      >
        <p className="text-xs font-semibold tracking-[0.18em] text-nb-text-faint uppercase">
          Open Documents
        </p>
        <p className="mt-1 text-sm text-nb-text-muted">
          {openDocuments.length}{' '}
          {openDocuments.length === 1 ? 'document' : 'documents'}
        </p>
      </div>
      <div
        id="open-documents-panel-list"
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
      >
        {openDocuments.length === 0 ? (
          <div
            id="open-documents-panel-empty"
            className="rounded-nb-sm border border-dashed border-nb-border bg-white/60 px-3 py-4 text-sm text-nb-text-muted"
          >
            No open documents yet.
          </div>
        ) : (
          <ul id="open-documents-list" className="space-y-1">
            {openDocuments.map((doc) => {
              const displayName = getNotebookDisplayName(doc.uri, doc.title)
              const isActive = doc.uri === currentDocUri
              const statusLabel = getNotebookStatusLabel(
                doc.state,
                doc.readOnly
              )
              const kind = isExcalidrawWorkspaceDocument(doc)
                ? 'Excalidraw'
                : isNotebookDocumentUri(doc.uri)
                  ? 'Notebook'
                  : isDocumentationDocumentUri(doc.uri)
                    ? 'Documentation'
                    : isNotebookDiffUri(doc.uri)
                      ? 'Diff'
                      : isDriveLinkStatusUri(doc.uri)
                        ? 'Status'
                        : isDriveSyncStatusUri(doc.uri)
                          ? 'Drive Sync'
                          : isVersionInfoUri(doc.uri)
                            ? 'Version'
                            : isRunnerStatusUri(doc.uri)
                              ? 'Runner Status'
                              : isAppConsoleUri(doc.uri)
                                ? 'App Console'
                                : isLogsUri(doc.uri)
                                  ? 'Logs'
                                  : 'Document'
              return (
                <li key={doc.uri}>
                  <div
                    id={`open-document-row-${encodeURIComponent(doc.uri)}`}
                    className={`group flex items-center gap-2 rounded-nb-sm border px-2 py-2 transition-colors ${
                      isActive
                        ? 'border-nb-accent bg-nb-accent-soft text-nb-text'
                        : 'border-transparent bg-transparent text-nb-text-muted hover:border-nb-border hover:bg-white/80 hover:text-nb-text'
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setCurrentDoc(doc.uri)}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate text-sm font-medium">
                          {displayName}
                        </div>
                        {statusLabel ? (
                          <span
                            id={`open-notebook-status-${encodeURIComponent(doc.uri)}`}
                            data-testid={
                              doc.readOnly
                                ? 'open-notebook-status-readonly'
                                : `open-notebook-status-${doc.state}`
                            }
                            className="shrink-0 rounded-nb-xs border border-nb-border bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-nb-text-muted"
                          >
                            {statusLabel}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-nb-text-faint">
                        {kind} · {doc.uri}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-nb-xs text-nb-text-faint transition-colors hover:bg-black/5 hover:text-nb-text"
                      aria-label={`Close ${displayName}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        handleCloseDocument(doc.uri)
                      }}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export function SidePanelToolbar() {
  const { activePanel, togglePanel } = useSidePanel()
  const { commentsPanelOpen, toggleCommentsPanel } = useCommentsPanel()
  const { showDocument } = useWorkspaceDocumentContext()
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()
  const authData = useBrowserAuthData()
  const browserAdapter = getBrowserAdapter()
  const {
    getServiceAccountCredentials,
    isDriveSyncing,
    logoutGoogleDrive,
    startGoogleDriveOAuth,
  } = useGoogleAuth()
  const { listRunners } = useRunners()
  const [driveContextMenu, setDriveContextMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const driveContextMenuItemRef = useRef<HTMLButtonElement | null>(null)
  const [accountContextMenu, setAccountContextMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const accountContextMenuItemRef = useRef<HTMLButtonElement | null>(null)
  const [loginConfiguration, setLoginConfiguration] = useState(
    readAppLoginConfiguration
  )
  const [loginConfigurationOpen, setLoginConfigurationOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  const driveStatus = isDriveSyncing ? 'Syncing' : 'Not syncing'
  const versionInfoSelected = getCurrentDoc() === VERSION_INFO_DOCUMENT_URI
  const appConsoleSelected = getCurrentDoc() === APP_CONSOLE_DOCUMENT_URI
  const logsSelected = getCurrentDoc() === LOGS_DOCUMENT_URI
  const driveSyncStatusSelected =
    getCurrentDoc() === DRIVE_SYNC_STATUS_DOCUMENT_URI
  const hasAvailableRunner = listRunners().some((runner) =>
    Boolean(runner.endpoint.trim())
  )
  const runnerStatus = hasAvailableRunner ? 'Available' : 'Unavailable'
  useEffect(() => {
    if (!driveContextMenu) {
      return
    }
    driveContextMenuItemRef.current?.focus()
    const handlePointerDown = () => setDriveContextMenu(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDriveContextMenu(null)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [driveContextMenu])

  useEffect(() => {
    if (!accountContextMenu) {
      return
    }
    accountContextMenuItemRef.current?.focus()
    const handlePointerDown = () => setAccountContextMenu(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountContextMenu(null)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [accountContextMenu])

  const handleOpenDriveSyncStatus = useCallback(() => {
    showDocument(DRIVE_SYNC_STATUS_DOCUMENT_URI, {
      title: 'Google Drive Sync Status',
    })
    setCurrentDoc(DRIVE_SYNC_STATUS_DOCUMENT_URI)
  }, [setCurrentDoc, showDocument])

  const handleDriveStatusClick = useCallback(async () => {
    setDriveContextMenu(null)
    try {
      await startGoogleDriveOAuth()
    } catch {
      // Users can cancel the interactive credential refresh.
    }
  }, [startGoogleDriveOAuth])

  const handleDriveLogout = useCallback(async () => {
    setDriveContextMenu(null)
    await logoutGoogleDrive()
  }, [logoutGoogleDrive])

  const openDriveContextMenu = useCallback((x: number, y: number) => {
    const menuWidth = 140
    const menuHeight = 80
    const maxX =
      typeof window === 'undefined' ? x : window.innerWidth - menuWidth
    const maxY =
      typeof window === 'undefined' ? y : window.innerHeight - menuHeight
    setDriveContextMenu({
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    })
  }, [])

  const handleDriveStatusContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      openDriveContextMenu(event.clientX, event.clientY)
    },
    [openDriveContextMenu]
  )

  const handleDriveStatusKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        !(
          event.key === 'ContextMenu' ||
          (event.shiftKey && event.key === 'F10')
        )
      ) {
        return
      }
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      openDriveContextMenu(rect.left + rect.width / 2, rect.bottom + 4)
    },
    [openDriveContextMenu]
  )

  const performConfiguredLogin = useCallback(
    async (configuration: AppLoginConfiguration) => {
      if (configuration.mode === 'principal') {
        await browserAdapter.loginWithRedirect()
        return
      }
      await getServiceAccountCredentials(configuration.serviceAccount, {
        prompt: 'select_account',
        authorizationLeaseSeconds: 24 * 60 * 60,
        accessTokenLifetimeSeconds: 60 * 60,
      })
    },
    [browserAdapter, getServiceAccountCredentials]
  )

  const handleLoginFailure = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setLoginError(message)
    setLoginConfigurationOpen(true)
  }, [])

  const handleAccountClick = useCallback(() => {
    setAccountContextMenu(null)
    if (authData) {
      browserAdapter.logout()
      return
    }
    setLoginError(null)
    setLoginBusy(true)
    void performConfiguredLogin(loginConfiguration)
      .catch(handleLoginFailure)
      .finally(() => setLoginBusy(false))
  }, [
    authData,
    browserAdapter,
    handleLoginFailure,
    loginConfiguration,
    performConfiguredLogin,
  ])

  const handleSaveLoginConfiguration = useCallback(
    (configuration: AppLoginConfiguration, login: boolean) => {
      const saved = saveAppLoginConfiguration(configuration)
      setLoginConfiguration(saved)
      setLoginError(null)
      if (!login) {
        setLoginConfigurationOpen(false)
        return
      }
      setLoginBusy(true)
      void performConfiguredLogin(saved)
        .then(() => setLoginConfigurationOpen(false))
        .catch(handleLoginFailure)
        .finally(() => setLoginBusy(false))
    },
    [handleLoginFailure, performConfiguredLogin]
  )

  const openAccountContextMenu = useCallback((x: number, y: number) => {
    const menuWidth = 190
    const menuHeight = 48
    const maxX =
      typeof window === 'undefined' ? x : window.innerWidth - menuWidth
    const maxY =
      typeof window === 'undefined' ? y : window.innerHeight - menuHeight
    setAccountContextMenu({
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    })
  }, [])

  const handleAccountContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      openAccountContextMenu(event.clientX, event.clientY)
    },
    [openAccountContextMenu]
  )

  const handleAccountKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        !(
          event.key === 'ContextMenu' ||
          (event.shiftKey && event.key === 'F10')
        )
      ) {
        return
      }
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      openAccountContextMenu(rect.left + rect.width / 2, rect.bottom + 4)
    },
    [openAccountContextMenu]
  )

  const handleVersionInfoClick = useCallback(() => {
    showDocument(VERSION_INFO_DOCUMENT_URI, {
      title: 'Version Information',
    })
    setCurrentDoc(VERSION_INFO_DOCUMENT_URI)
  }, [setCurrentDoc, showDocument])

  const handleRunnerStatusClick = useCallback(() => {
    showDocument(RUNNER_STATUS_DOCUMENT_URI, {
      title: 'Notebook Runner Status',
    })
    setCurrentDoc(RUNNER_STATUS_DOCUMENT_URI)
  }, [setCurrentDoc, showDocument])

  const handleAppConsoleClick = useCallback(() => {
    showDocument(APP_CONSOLE_DOCUMENT_URI, {
      title: 'App Console',
    })
    setCurrentDoc(APP_CONSOLE_DOCUMENT_URI)
  }, [setCurrentDoc, showDocument])

  const handleLogsClick = useCallback(() => {
    showDocument(LOGS_DOCUMENT_URI, {
      title: 'Logs',
    })
    setCurrentDoc(LOGS_DOCUMENT_URI)
  }, [setCurrentDoc, showDocument])

  return (
    <div className="flex h-full w-12 flex-col items-center justify-between">
      <div className="flex flex-col items-center gap-2 pt-2">
        <button
          type="button"
          data-tour-id="left-nav.explorer"
          className={`${sideButtonBase} ${
            activePanel === 'explorer' ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={activePanel === 'explorer'}
          aria-label="Toggle Explorer panel"
          onClick={() => togglePanel('explorer')}
        >
          <FolderIcon className="h-5 w-5" />
          <span className={tooltipBase}>File Explorer</span>
        </button>
        <button
          type="button"
          data-tour-id="left-nav.open-documents"
          className={`${sideButtonBase} ${
            activePanel === 'open-documents'
              ? sideButtonActive
              : sideButtonInactive
          }`}
          aria-pressed={activePanel === 'open-documents'}
          aria-label="Toggle Open Documents panel"
          onClick={() => togglePanel('open-documents')}
        >
          <QueueListIcon className="h-5 w-5" />
          <span className={tooltipBase}>Open Documents</span>
        </button>
        <button
          type="button"
          data-tour-id="left-nav.outline"
          className={`${sideButtonBase} ${
            activePanel === 'outline' ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={activePanel === 'outline'}
          aria-label="Toggle Outline panel"
          onClick={() => togglePanel('outline')}
        >
          <Bars3BottomLeftIcon className="h-5 w-5" />
          <span className={tooltipBase}>Outline</span>
        </button>
        <button
          type="button"
          data-tour-id="left-nav.comments"
          className={`${sideButtonBase} ${
            commentsPanelOpen ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={commentsPanelOpen}
          aria-label="Toggle Comments panel"
          onClick={toggleCommentsPanel}
        >
          <ChatBubbleLeftIcon className="h-5 w-5" />
          <span className={tooltipBase}>Comments</span>
        </button>
        <button
          type="button"
          data-tour-id="left-nav.app-console"
          className={`${sideButtonBase} ${
            appConsoleSelected ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={appConsoleSelected}
          aria-label="Open App Console"
          onClick={handleAppConsoleClick}
        >
          <CommandLineIcon className="h-5 w-5" />
          <span className={tooltipBase}>App Console</span>
        </button>
        <button
          type="button"
          data-tour-id="left-nav.logs"
          className={`${sideButtonBase} ${
            logsSelected ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={logsSelected}
          aria-label="Open Logs"
          onClick={handleLogsClick}
        >
          <DocumentTextIcon className="h-5 w-5" />
          <span className={tooltipBase}>Logs</span>
        </button>
      </div>
      <div className="flex flex-col items-center gap-2 pb-2">
        <button
          type="button"
          data-tour-id="left-nav.runner-status"
          className={`${sideButtonBase} ${
            getCurrentDoc() === RUNNER_STATUS_DOCUMENT_URI
              ? sideButtonActive
              : sideButtonInactive
          }`}
          aria-label={`Runner status: ${runnerStatus}`}
          onClick={handleRunnerStatusClick}
        >
          <span className="relative inline-flex h-5 w-5 items-center justify-center">
            <ServerStackIcon
              className={`h-5 w-5 ${
                hasAvailableRunner ? 'text-emerald-500' : 'text-red-500'
              }`}
            />
            {!hasAvailableRunner && (
              <span className="pointer-events-none absolute h-0.5 w-6 -rotate-45 rounded bg-red-600" />
            )}
          </span>
          <span className={tooltipBase}>{`Runner: ${runnerStatus}`}</span>
        </button>
        <button
          type="button"
          data-tour-id="left-nav.google-drive"
          className={`${sideButtonBase} ${
            driveSyncStatusSelected ? sideButtonActive : sideButtonInactive
          }`}
          aria-label={`Google Drive status: ${driveStatus}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(driveContextMenu)}
          onClick={() => {
            void handleDriveStatusClick()
          }}
          onContextMenu={handleDriveStatusContextMenu}
          onKeyDown={handleDriveStatusKeyDown}
        >
          <span className="relative inline-flex h-5 w-5 items-center justify-center">
            <CloudSolidIcon
              className={`h-5 w-5 ${
                isDriveSyncing ? 'text-emerald-500' : 'text-red-500'
              }`}
            />
            {!isDriveSyncing && (
              <span className="pointer-events-none absolute h-0.5 w-6 -rotate-45 rounded bg-red-600" />
            )}
          </span>
          <span className={tooltipBase}>{`Google Drive: ${driveStatus}`}</span>
        </button>
        {driveContextMenu ? (
          <div
            role="menu"
            aria-label="Google Drive status actions"
            className="fixed z-50 min-w-32 rounded-nb-sm border border-nb-border bg-white py-1 text-sm shadow-nb-md"
            style={{
              top: driveContextMenu.y,
              left: driveContextMenu.x,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              ref={driveContextMenuItemRef}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-nb-text hover:bg-nb-surface-2"
              onClick={() => {
                setDriveContextMenu(null)
                handleOpenDriveSyncStatus()
              }}
            >
              Status
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-nb-text hover:bg-nb-surface-2"
              onClick={() => {
                void handleDriveLogout()
              }}
            >
              Logout
            </button>
          </div>
        ) : null}
        <button
          type="button"
          data-tour-id="left-nav.account"
          className={`${sideButtonBase} ${sideButtonInactive}`}
          aria-label={authData ? 'Logout' : 'Login'}
          aria-haspopup="menu"
          aria-expanded={Boolean(accountContextMenu)}
          onClick={handleAccountClick}
          onContextMenu={handleAccountContextMenu}
          onKeyDown={handleAccountKeyDown}
        >
          <UserCircleIcon className="h-5 w-5" />
          <span className={tooltipBase}>{authData ? 'Logout' : 'Login'}</span>
        </button>
        {accountContextMenu ? (
          <div
            role="menu"
            aria-label="Application login actions"
            className="fixed z-50 min-w-48 rounded-nb-sm border border-nb-border bg-white py-1 text-sm shadow-nb-md"
            style={{
              top: accountContextMenu.y,
              left: accountContextMenu.x,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              ref={accountContextMenuItemRef}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-nb-text hover:bg-nb-surface-2"
              onClick={() => {
                setAccountContextMenu(null)
                setLoginError(null)
                setLoginConfigurationOpen(true)
              }}
            >
              Configure login…
            </button>
          </div>
        ) : null}
        <button
          type="button"
          data-tour-id="left-nav.documentation"
          className={`${sideButtonBase} ${
            activePanel === 'documentation'
              ? sideButtonActive
              : sideButtonInactive
          }`}
          aria-pressed={activePanel === 'documentation'}
          aria-label="Toggle Documentation panel"
          onClick={() => togglePanel('documentation')}
        >
          <BookOpenIcon className="h-5 w-5" />
          <span className={tooltipBase}>Documentation</span>
        </button>
        <button
          type="button"
          data-tour-id="left-nav.version"
          className={`${sideButtonBase} ${
            versionInfoSelected ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={versionInfoSelected}
          aria-label="Open Version Information"
          onClick={handleVersionInfoClick}
        >
          <InformationCircleIcon className="h-5 w-5" />
          <span className={tooltipBase}>Version Information</span>
        </button>
      </div>
      <LoginConfigurationDialog
        configuration={loginConfiguration}
        open={loginConfigurationOpen}
        busy={loginBusy}
        errorMessage={loginError}
        onOpenChange={(open) => {
          if (!loginBusy) {
            setLoginConfigurationOpen(open)
          }
        }}
        onSave={handleSaveLoginConfiguration}
      />
    </div>
  )
}

export function SidePanelContent() {
  const { activePanel } = useSidePanel()

  return (
    <div className="relative h-full min-h-0 w-full">
      <div
        className={`h-full min-h-0 w-full ${activePanel === 'explorer' ? 'flex' : 'hidden'}`}
        aria-hidden={activePanel !== 'explorer'}
      >
        <WorkspaceExplorer />
      </div>
      <div
        className={`h-full min-h-0 w-full ${activePanel === 'documentation' ? 'flex' : 'hidden'}`}
        aria-hidden={activePanel !== 'documentation'}
      >
        <DocumentationExplorer />
      </div>
      <div
        className={`h-full min-h-0 w-full ${activePanel === 'open-documents' ? 'flex' : 'hidden'}`}
        aria-hidden={activePanel !== 'open-documents'}
      >
        <OpenDocumentsPanel />
      </div>
      {activePanel === 'outline' ? (
        <div className="flex h-full min-h-0 w-full">
          <NotebookOutlinePanel />
        </div>
      ) : null}
    </div>
  )
}
