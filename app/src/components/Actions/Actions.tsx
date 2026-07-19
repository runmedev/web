import {
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { create } from '@bufbuild/protobuf'
import { Button, ScrollArea, Tabs, Text } from '@radix-ui/themes'

import {
  ChatBubbleLeftIcon,
  LinkIcon,
  LockClosedIcon,
  PhotoIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid'
import { MimeType, RunmeMetadataKey, parser_pb } from '../../runme/client'
import { CellData } from '../../lib/notebookData'
import { useNotebookContext } from '../../contexts/NotebookContext'
import type { OpenNotebookEntry } from '../../lib/notebookDataController'
import type { NotebookOwnershipRecord } from '../../lib/tabCoordination/notebookOwnership'
import { useNotebookStore } from '../../contexts/NotebookStoreContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import { useOutput } from '../../contexts/OutputContext'
import CellConsole, { fontSettings } from './CellConsole'
import Editor from './Editor'
import HtmlCell from './HtmlCell'
import MarkdownCell from './MarkdownCell'
import { appLogger } from '../../lib/logging/runtime'
import {
  createNotebookActiveCellState,
  loadNotebookActiveCellMap,
  persistNotebookActiveCellMap,
  type CellFocusRole,
  type NotebookActiveCellMap,
  type NotebookActiveCellState,
} from '../../lib/notebookActiveCellState'
import {
  copyNotebookCellShareUrl,
  copyNotebookMarkdownLink,
  copyNotebookShareUrl,
  parseNotebookCellFragment,
} from '../../lib/shareLinks'
import { isHtmlLanguageId, isMarkdownLanguageId } from '../../lib/cellContent'
import { PlayIcon, PlusIcon, SpinnerIcon, TrashIcon } from './icons'
//import { useRun } from "../../lib/useRun.js";
import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useRunners } from '../../contexts/RunnersContext'
import { useCommentsPanel } from '../../contexts/CommentsPanelContext'
import { DEFAULT_RUNNER_PLACEHOLDER } from '../../lib/runtime/runnersManager'
import {
  APPKERNEL_RUNNER_NAME,
  APPKERNEL_SANDBOX_RUNNER_NAME,
  isAppKernelRunnerName,
} from '../../lib/runtime/appKernel'
import { getJupyterManager } from '../../lib/runtime/jupyterManager'
import {
  driveLinkCoordinator,
  DRIVE_LINK_STATUS_TAB_URI,
  useDriveLinkCoordinatorSnapshot,
} from '../../lib/driveLinkCoordinator'
import {
  isDriveLinkStatusUri,
  isDriveSyncStatusUri,
  isAppConsoleUri,
  isExcalidrawWorkspaceDocument,
  isLogsUri,
  isNotebookDiffUri,
  isNotebookDocumentUri,
  isVersionInfoUri,
  isRunnerStatusUri,
  type WorkspaceDocument,
} from '../../lib/workspaceDocuments/workspaceDocumentTypes'
import {
  getNotebookDiffDocument,
  NOTEBOOK_DIFF_DOCUMENT_CHANGED,
} from '../../lib/notebookDiff/registry'
import {
  openNotebookConflictDiff,
  openNotebookUpstreamDiff,
} from '../../lib/notebookDiff/conflict'
import {
  isDriveItemUri,
  parseDriveItem,
  type DriveComment,
} from '../../storage/drive'
import type { NotebookSyncState } from '../../storage/local'
import { NotebookStoreItemType } from '../../storage/notebook'
import { showToast } from '../../lib/toast'
import {
  embedImageInNotebook,
  isSupportedImageFile,
  pickImageFromLocalFilesystem,
} from '../../lib/imageEmbedding'
import { appState } from '../../lib/runtime/AppState'
import {
  createCellCommentAnchor,
  groupCommentsByCell,
  toCellCommentThreads,
} from '../../lib/notebookComments'
import DriveLinkStatusTab from '../DriveLinkStatusTab'
import DriveSyncStatusTab from '../DriveSyncStatusTab'
import RunnerStatusTab from '../RunnerStatusTab'
import { NotebookDiffContent } from '../NotebookDiff/NotebookDiffView'
import VersionInfoTab from '../VersionInfoTab'
import { NotebookCommentsPanel } from '../NotebookCommentsPanel'
import AppConsole from '../AppConsole/AppConsole'
import LogsPane from '../Logs/LogsPane'
import { ActionOutputItems } from './ActionOutputItems'
import React from 'react'
import ExcalidrawDocument from '../Excalidraw/ExcalidrawDocument'

type TabPanelProps = React.HTMLAttributes<HTMLDivElement> & {
  'data-state'?: 'active' | 'inactive'
  hidden?: boolean
}

const TabPanel = React.forwardRef<HTMLDivElement, TabPanelProps>(
  ({ hidden: _hiddenProp, 'data-state': state, style, ...rest }, ref) => {
    const inactive = state !== 'active'
    return (
      <div
        ref={ref}
        data-state={state}
        style={{
          ...style,
          visibility: inactive ? 'hidden' : 'visible',
          position: inactive ? 'absolute' : 'relative',
          inset: inactive ? 0 : undefined,
          height: '100%',
          pointerEvents: inactive ? 'none' : 'auto',
          zIndex: inactive ? 0 : 1,
          transition: 'none',
        }}
        {...rest}
      />
    )
  }
)
TabPanel.displayName = 'TabPanel'
// TabPanel is used with Tabs.Content + forceMount to keep every tab's DOM alive
// (preserving scroll/Monaco layout) while hiding inactive tabs without stacking
// them. Inactive tabs are taken out of flow via absolute positioning and hidden
// visibility so they don't visually overlap yet retain their state.

function getNotebookDisplayName(uri: string, name?: string): string {
  return name || uri.split('/').filter(Boolean).pop() || uri
}

// Ownership records created before ownerSessionId existed can still be active
// in IndexedDB, so UI reads the explicit field first and falls back to the URL.
function getNotebookOwnerSessionId(
  owner: NotebookOwnershipRecord | null | undefined
): string | null {
  const explicitSession = owner?.ownerSessionId?.trim()
  if (explicitSession) {
    return explicitSession
  }
  const ownerUrl = owner?.ownerUrl?.trim()
  if (!ownerUrl) {
    return null
  }
  try {
    return new URL(ownerUrl).searchParams.get('session')?.trim() || null
  } catch {
    return null
  }
}

function syncIndicatorPresentation(state: NotebookSyncState | null): {
  label: string
  className: string
  clickable: boolean
} {
  switch (state?.status) {
    case 'synced':
      return {
        label: 'Notebook is synced',
        className: 'bg-emerald-500',
        clickable: false,
      }
    case 'pending':
      return {
        label:
          'Notebook has local changes pending upstream sync. Click to sync now.',
        className: 'bg-red-500',
        clickable: true,
      }
    case 'pending-upstream-create':
      return {
        label:
          'Notebook is waiting for its upstream file to be created. Click to sync now.',
        className: 'bg-amber-500',
        clickable: true,
      }
    case 'syncing':
      return {
        label: 'Notebook is syncing',
        className: 'bg-sky-500 animate-pulse',
        clickable: false,
      }
    case 'conflicted':
      return {
        label: 'Notebook has a sync conflict. Click to review differences.',
        className: 'bg-amber-600',
        clickable: true,
      }
    case 'error':
      return {
        label: state.lastError
          ? `Notebook sync failed: ${state.lastError}. Click to retry.`
          : 'Notebook sync failed. Click to retry.',
        className: 'bg-red-700',
        clickable: true,
      }
    case 'local-only':
      return {
        label: 'Notebook is stored only in this browser',
        className: 'border border-nb-text-faint bg-transparent',
        clickable: false,
      }
    default:
      return {
        label: 'Notebook sync state is loading',
        className: 'border border-nb-text-faint bg-transparent',
        clickable: false,
      }
  }
}

function useNotebookSyncState(docUri: string): NotebookSyncState | null {
  const { store } = useNotebookStore()
  const [syncState, setSyncState] = useState<NotebookSyncState | null>(null)

  useEffect(() => {
    if (!store || !docUri.startsWith('local://file/')) {
      setSyncState(null)
      return
    }

    let cancelled = false
    const refresh = () => {
      void (async () => {
        try {
          const next = await store.getSyncState(docUri)
          if (!cancelled) {
            setSyncState(next)
          }
        } catch (error) {
          if (!cancelled) {
            setSyncState({
              status: 'error',
              localUri: docUri,
              remoteId: '',
              lastError: String(error),
            })
          }
        }
      })()
    }

    refresh()
    const unsubscribe = store.subscribeSync(docUri, refresh)
    const onSyncUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ uri?: string }>).detail
      if (detail?.uri === docUri) {
        refresh()
      }
    }
    window.addEventListener('local-notebook-sync-updated', onSyncUpdated)
    window.addEventListener('local-notebook-updated', onSyncUpdated)
    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener('local-notebook-sync-updated', onSyncUpdated)
      window.removeEventListener('local-notebook-updated', onSyncUpdated)
    }
  }, [docUri, store])

  return syncState
}

function NotebookSyncIndicator({ docUri }: { docUri: string }) {
  const { store } = useNotebookStore()
  const syncState = useNotebookSyncState(docUri)

  const presentation = syncIndicatorPresentation(syncState)
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (!store || !presentation.clickable) {
        return
      }
      if (syncState?.status === 'conflicted') {
        void openNotebookConflictDiff(store, docUri).catch((error) => {
          appLogger.warn('Notebook conflict diff failed to open', {
            attrs: {
              scope: 'storage.local.sync',
              localUri: docUri,
              error: String(error),
            },
          })
          showToast({
            message: 'Unable to open conflict diff. Please try again.',
            tone: 'error',
          })
        })
        return
      }
      void store.sync(docUri).catch((error) => {
        appLogger.warn('Notebook tab immediate sync failed', {
          attrs: {
            scope: 'storage.local.sync',
            localUri: docUri,
            error: String(error),
          },
        })
      })
    },
    [docUri, presentation.clickable, store, syncState?.status]
  )

  if (!store || !docUri.startsWith('local://file/')) {
    return null
  }

  return (
    <button
      type="button"
      aria-label={presentation.label}
      title={presentation.label}
      className="inline-flex h-5 w-5 items-center justify-center rounded-full"
      onClick={handleClick}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <span
        className={`block h-2.5 w-2.5 rounded-full ${presentation.className}`}
      />
    </button>
  )
}

function NotebookDriveLoadingState() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-nb-text-muted"
      data-testid="notebook-drive-loading-state"
    >
      <Text size="3" weight="bold" as="p" className="text-nb-text">
        Loading notebook from Google Drive
      </Text>
      <Text size="2" as="p">
        Syncing the latest Drive copy before showing cells.
      </Text>
    </div>
  )
}

function isDriveBackedNotebook(
  entry: OpenNotebookEntry,
  syncState: NotebookSyncState | null
): boolean {
  return (
    isDriveItemUri(entry.requestedUri) || isDriveItemUri(syncState?.remoteId)
  )
}

function ReadOnlyTabIndicator() {
  return (
    <span
      className="relative inline-flex h-4 w-4 items-center justify-center text-nb-text-muted"
      role="img"
      aria-label="Read-only notebook"
    >
      <LockClosedIcon className="h-3.5 w-3.5" aria-hidden="true" />
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-20 hidden w-max max-w-[220px] -translate-x-1/2 rounded-nb-sm border border-nb-border bg-white px-2 py-1 text-xs font-normal text-nb-text shadow-nb-sm group-hover:inline-block group-focus:inline-block"
      >
        Read-only. This notebook is open for editing in another browser tab.
      </span>
    </span>
  )
}

/** Compact icon-only run button that sits in the cell toolbar.
 *  Shows a spinner while running, otherwise always shows the play icon. */
function RunActionButton({
  pid,
  onClick,
  disabled = false,
}: {
  pid: number | null
  onClick: () => void
  disabled?: boolean
}) {
  const isRunning = pid !== null

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={isRunning ? 'Running...' : 'Run code'}
      className="icon-btn h-7 w-7"
    >
      {isRunning ? (
        <div className="animate-spin">
          <SpinnerIcon />
        </div>
      ) : (
        <PlayIcon />
      )}
    </button>
  )
}

function CellCommentButton({
  count,
  available,
  onClick,
  className = '',
}: {
  count: number
  available: boolean
  onClick: () => void
  className?: string
}) {
  const label =
    count > 0
      ? `${count} open comments`
      : available
        ? 'Add comment'
        : 'Comments unavailable'
  const stateClass = available
    ? 'text-nb-accent hover:bg-nb-accent-muted hover:text-nb-accent focus-visible:bg-nb-accent-muted focus-visible:text-nb-accent'
    : 'text-nb-text-faint'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!available}
      aria-label={label}
      title={label}
      className={`icon-btn disabled:cursor-not-allowed disabled:opacity-100 ${stateClass} ${className}`}
    >
      <ChatBubbleLeftIcon className="h-4 w-4" />
      {count > 0 && (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-nb-accent px-1 text-[10px] font-semibold leading-4 text-white">
          {count}
        </span>
      )}
    </button>
  )
}

function CellLinkButton({
  onClick,
  className = '',
}: {
  onClick: () => void
  className?: string
}) {
  const label = 'Copy link to cell'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`icon-btn text-nb-text-muted hover:bg-nb-accent-muted hover:text-nb-accent focus-visible:bg-nb-accent-muted focus-visible:text-nb-accent ${className}`}
    >
      <LinkIcon className="h-4 w-4" />
    </button>
  )
}

// Action is an editor and an optional Runme console
const LANGUAGE_OPTIONS = [
  { label: 'Markdown', value: 'markdown' },
  { label: 'HTML', value: 'html' },
  { label: 'Bash', value: 'bash' },
  { label: 'Jupyter', value: 'jupyter' },
  { label: 'Python', value: 'python' },
  { label: 'JS', value: 'javascript' },
] as const

const JAVASCRIPT_RUNNER_OPTIONS = [
  { label: 'browser', value: APPKERNEL_RUNNER_NAME },
  { label: 'sandbox', value: APPKERNEL_SANDBOX_RUNNER_NAME },
] as const

type SupportedLanguage =
  | 'bash'
  | 'html'
  | 'jupyter'
  | 'javascript'
  | 'markdown'
  | 'python'

function isGoogleDriveFileUri(uri: string | null | undefined): uri is string {
  if (!uri) {
    return false
  }
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (!/(^|\.)drive\.google\.com$/i.test(url.hostname)) {
    return false
  }
  try {
    return parseDriveItem(uri).type === NotebookStoreItemType.File
  } catch {
    return false
  }
}

function normalizeLanguageId(
  kind: parser_pb.CellKind,
  languageId?: string | null
): SupportedLanguage {
  switch (kind) {
    case parser_pb.CellKind.CODE:
      const normalized = (languageId ?? '').toLowerCase()
      if (isMarkdownLanguageId(normalized)) {
        return 'markdown'
      }
      if (isHtmlLanguageId(normalized)) {
        return 'html'
      }
      if (normalized === 'python' || normalized === 'py') {
        return 'python'
      }
      if (normalized === 'jupyter' || normalized === 'ipython') {
        return 'jupyter'
      }
      if (
        normalized === 'javascript' ||
        normalized === 'typescript' ||
        normalized === 'js' ||
        normalized === 'ts' ||
        normalized === 'observable' ||
        normalized === 'd3'
      ) {
        return 'javascript'
      }
      return 'bash'
    case parser_pb.CellKind.MARKUP:
      return 'markdown'
    default:
      return 'bash'
  }
}

export function Action({
  cellData,
  docUri = '',
  isFirst,
  isActiveCell = false,
  activeFocusRole = 'editor',
  isWindowFocused = false,
  onFocusStateChange,
  readOnly = false,
  commentsAvailable = false,
  commentCount = 0,
  onStartComment,
  isDeepLinkTarget = false,
}: {
  cellData: CellData
  docUri?: string
  isFirst: boolean
  isActiveCell?: boolean
  activeFocusRole?: CellFocusRole
  isWindowFocused?: boolean
  onFocusStateChange?: (state: NotebookActiveCellState) => void
  readOnly?: boolean
  commentsAvailable?: boolean
  commentCount?: number
  onStartComment?: (cellId: string) => void
  isDeepLinkTarget?: boolean
}) {
  const { store } = useNotebookStore()
  const { listRunners, defaultRunnerName } = useRunners()
  const jupyterManager = useMemo(() => getJupyterManager(), [])
  const jupyterVersion = useSyncExternalStore(
    useCallback(
      (listener) => jupyterManager.subscribe(listener),
      [jupyterManager]
    ),
    useCallback(() => jupyterManager.getVersion(), [jupyterManager]),
    useCallback(() => jupyterManager.getVersion(), [jupyterManager])
  )
  const cell = useSyncExternalStore(
    useCallback(
      (listener) => cellData.subscribeToContentChange(listener),
      [cellData]
    ),
    useCallback(() => cellData.snapshot, [cellData]),
    useCallback(() => cellData.snapshot, [cellData])
  )
  // Derive runID from the current cell snapshot so clear/reset operations
  // immediately repaint output visibility without requiring a separate listener.
  const runID = cellData.getRunID()

  const handleAddCellBefore = useCallback(() => {
    if (readOnly) {
      return
    }
    cellData.addBefore(parser_pb.CellKind.CODE, cell?.languageId)
  }, [cell?.languageId, cellData, readOnly])

  const handleAddCellAfter = useCallback(() => {
    if (readOnly) {
      return
    }
    cellData.addAfter(parser_pb.CellKind.CODE, cell?.languageId)
  }, [cell?.languageId, cellData, readOnly])

  const updateCellLocal = useCallback(
    (nextCell: parser_pb.Cell) => {
      if (readOnly) {
        return
      }
      cellData.update(nextCell)
    },
    [cellData, readOnly]
  )

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const [shareTarget, setShareTarget] = useState<{
    docUri: string
    targetUri: string | null
  }>(() => {
    const fallbackUri = docUri.trim() || null
    return {
      docUri,
      targetUri: store && docUri.startsWith('local://') ? null : fallbackUri,
    }
  })
  const shareTargetUri =
    shareTarget.docUri === docUri ? shareTarget.targetUri : null
  const [htmlEditRequest, setHtmlEditRequest] = useState(0)
  const [markdownEditRequest, setMarkdownEditRequest] = useState(0)
  const [pid, setPid] = useState<number | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)

  useEffect(() => {
    const fallbackUri = docUri.trim() || null
    if (!store || !docUri.startsWith('local://')) {
      setShareTarget({ docUri, targetUri: fallbackUri })
      return
    }

    let cancelled = false
    setShareTarget({ docUri, targetUri: null })
    void (async () => {
      try {
        const metadata = await store.getMetadata(docUri)
        if (!cancelled) {
          setShareTarget({
            docUri,
            targetUri: metadata?.remoteUri?.trim() || fallbackUri,
          })
        }
      } catch {
        if (!cancelled) {
          setShareTarget({ docUri, targetUri: fallbackUri })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [docUri, store])

  // When an exit code arrives, clear the pid so the spinner stops.
  const handleExitCode = useCallback((code: number | null) => {
    setExitCode(code)
    if (code !== null) {
      setPid(null)
    }
  }, [])

  useEffect(() => {
    if (!contextMenu) {
      return
    }

    const handleClick = () => setContextMenu(null)
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
      }
    }

    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)

    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu])

  const adjustedContextMenu = useMemo(() => {
    if (!contextMenu) {
      return null
    }

    if (typeof window === 'undefined') {
      return contextMenu
    }

    const menuWidth = 200
    const menuHeight = shareTargetUri && cell?.refId.trim() ? 128 : 88
    const left = Math.max(
      0,
      Math.min(contextMenu.x, window.innerWidth - menuWidth)
    )
    const top = Math.max(
      0,
      Math.min(contextMenu.y, window.innerHeight - menuHeight)
    )
    return { x: left, y: top }
  }, [cell?.refId, contextMenu, shareTargetUri])

  const runCode = useCallback(() => {
    if (readOnly) {
      return
    }
    cellData.run()
  }, [cellData, readOnly])

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setContextMenu({ x: event.clientX, y: event.clientY })
    },
    []
  )

  const handleFocusCapture = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (!cell?.refId || !onFocusStateChange) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      const focusRoleElement = target.closest<HTMLElement>(
        '[data-cell-focus-role]'
      )
      if (!focusRoleElement) {
        return
      }
      const focusRole =
        focusRoleElement.dataset.cellFocusRole === 'rendered'
          ? 'rendered'
          : 'editor'
      const nextState = createNotebookActiveCellState(cell.refId, focusRole)
      if (!nextState) {
        return
      }
      onFocusStateChange(nextState)
    },
    [cell?.refId, onFocusStateChange]
  )

  const handleMarkdownFocusRoleChange = useCallback(
    (focusRole: CellFocusRole) => {
      if (!cell?.refId || !onFocusStateChange) {
        return
      }
      const nextState = createNotebookActiveCellState(cell.refId, focusRole)
      if (!nextState) {
        return
      }
      onFocusStateChange(nextState)
    },
    [cell?.refId, onFocusStateChange]
  )

  const handleRemoveCell = useCallback(() => {
    if (readOnly) {
      setContextMenu(null)
      return
    }
    cellData.remove()
    setContextMenu(null)
  }, [cellData, readOnly])

  const handleCopyShareLink = useCallback(async () => {
    if (!shareTargetUri || !cell?.refId) {
      setContextMenu(null)
      return
    }

    try {
      await copyNotebookCellShareUrl(shareTargetUri, cell.refId)
      showToast({ message: 'Link to cell copied', tone: 'success' })
    } catch (error) {
      appLogger.error('Failed to copy notebook cell link from cell menu', {
        attrs: {
          scope: 'notebook.share',
          code: 'NOTEBOOK_CELL_LINK_COPY_FAILED',
          notebookUri: shareTargetUri,
          cellRefId: cell.refId,
          error: String(error),
        },
      })
      showToast({
        message:
          'Could not copy the cell link. Check clipboard permissions and try again.',
        tone: 'error',
      })
    } finally {
      setContextMenu(null)
    }
  }, [cell?.refId, shareTargetUri])

  const handleStartComment = useCallback(() => {
    if (!cell?.refId || !onStartComment) {
      setContextMenu(null)
      return
    }
    onStartComment(cell.refId)
    setContextMenu(null)
  }, [cell?.refId, onStartComment])

  const sequenceLabel = useMemo(() => {
    if (!cell) {
      return ' '
    }
    const seq = Number(cell.metadata[RunmeMetadataKey.Sequence])
    if (!seq) {
      return ' '
    }
    return seq.toString()
  }, [cell, pid, exitCode])

  const selectedLanguage = useMemo(() => {
    if (!cell) {
      return 'bash'
    }
    return normalizeLanguageId(cell.kind, cell.languageId)
  }, [cell])

  const editorLanguage = useMemo(() => {
    switch (selectedLanguage) {
      case 'html':
        return 'html'
      case 'markdown':
        return 'markdown'
      case 'javascript':
        return 'javascript'
      case 'jupyter':
        return 'python'
      case 'python':
        return 'python'
      default:
        return 'shellscript'
    }
  }, [selectedLanguage])

  const languageSelectId = useMemo(
    () => `language-select-${cell?.refId ?? 'unknown'}`,
    [cell?.refId]
  )
  const runnerSelectId = useMemo(
    () => `runner-select-${cell?.refId ?? 'unknown'}`,
    [cell?.refId]
  )
  const kernelSelectId = useMemo(
    () => `kernel-select-${cell?.refId ?? 'unknown'}`,
    [cell?.refId]
  )

  var initialRunnerName = cellData.getRunnerName()
  if (!initialRunnerName) {
    initialRunnerName = DEFAULT_RUNNER_PLACEHOLDER
  }
  const isJavascriptLanguage = selectedLanguage === 'javascript'
  const runnerSelectionName =
    selectedLanguage === 'jupyter' && isAppKernelRunnerName(initialRunnerName)
      ? DEFAULT_RUNNER_PLACEHOLDER
      : initialRunnerName
  const resolvedRunnerName =
    runnerSelectionName === DEFAULT_RUNNER_PLACEHOLDER
      ? (defaultRunnerName ?? '')
      : runnerSelectionName
  const showRunnerSelector =
    selectedLanguage === 'bash' ||
    selectedLanguage === 'python' ||
    isJavascriptLanguage
  const showKernelSelector = selectedLanguage === 'jupyter'
  const runnerSelectValue = isJavascriptLanguage
    ? initialRunnerName === APPKERNEL_SANDBOX_RUNNER_NAME
      ? APPKERNEL_SANDBOX_RUNNER_NAME
      : APPKERNEL_RUNNER_NAME
    : isAppKernelRunnerName(initialRunnerName)
      ? DEFAULT_RUNNER_PLACEHOLDER
      : initialRunnerName
  const hasJupyterSelection =
    Boolean(cell?.metadata?.[RunmeMetadataKey.JupyterServerName]) ||
    Boolean(cell?.metadata?.[RunmeMetadataKey.JupyterKernelID]) ||
    Boolean(cell?.metadata?.[RunmeMetadataKey.JupyterKernelName])
  const availableRunnerNames = useMemo(
    () =>
      listRunners()
        .map((runner) => runner.name)
        .filter((name) => !isAppKernelRunnerName(name)),
    [listRunners]
  )
  const jupyterRunnerNames = useMemo(() => {
    const names = new Set<string>()
    if (resolvedRunnerName) {
      names.add(resolvedRunnerName)
    }
    availableRunnerNames.forEach((name) => names.add(name))
    return [...names]
  }, [availableRunnerNames, resolvedRunnerName])

  useEffect(() => {
    if (selectedLanguage !== 'jupyter') {
      return
    }
    if (jupyterRunnerNames.length === 0) {
      return
    }
    void Promise.all(
      jupyterRunnerNames.map((runnerName) =>
        jupyterManager.ensureRunnerData(runnerName).catch((error) => {
          console.error('Failed to load Jupyter kernels for runner', {
            runner: runnerName,
            error,
          })
        })
      )
    )
  }, [jupyterManager, jupyterRunnerNames, resolvedRunnerName, selectedLanguage])

  useEffect(() => {
    if (readOnly) {
      return
    }
    if (
      selectedLanguage === 'javascript' &&
      !isAppKernelRunnerName(initialRunnerName)
    ) {
      cellData.setRunner(APPKERNEL_RUNNER_NAME)
      if (hasJupyterSelection) {
        cellData.clearJupyterKernel()
      }
      return
    }
    if (selectedLanguage === 'markdown') {
      if (initialRunnerName !== DEFAULT_RUNNER_PLACEHOLDER) {
        cellData.setRunner(DEFAULT_RUNNER_PLACEHOLDER)
      }
      if (hasJupyterSelection) {
        cellData.clearJupyterKernel()
      }
      return
    }
    if (selectedLanguage === 'html') {
      if (initialRunnerName !== DEFAULT_RUNNER_PLACEHOLDER) {
        cellData.setRunner(DEFAULT_RUNNER_PLACEHOLDER)
      }
      if (hasJupyterSelection) {
        cellData.clearJupyterKernel()
      }
      return
    }
    if (
      selectedLanguage === 'jupyter' &&
      isAppKernelRunnerName(initialRunnerName)
    ) {
      cellData.setRunner(DEFAULT_RUNNER_PLACEHOLDER)
      if (hasJupyterSelection) {
        cellData.clearJupyterKernel()
      }
    }
  }, [
    cellData,
    hasJupyterSelection,
    initialRunnerName,
    readOnly,
    selectedLanguage,
  ])

  const kernelOptions = useMemo(() => {
    if (!showKernelSelector || jupyterRunnerNames.length === 0) {
      return []
    }
    const deduped = new Map<
      string,
      ReturnType<typeof jupyterManager.getKernelOptionsForRunner>[number]
    >()
    jupyterRunnerNames.forEach((runnerName) => {
      try {
        const options = jupyterManager.getKernelOptionsForRunner(runnerName)
        options.forEach((option) => {
          deduped.set(option.key, option)
        })
      } catch (error) {
        console.error('Failed to build Jupyter kernel options for runner', {
          runner: runnerName,
          error,
        })
      }
    })
    return [...deduped.values()].sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        a.runnerName.localeCompare(b.runnerName)
    )
  }, [jupyterManager, jupyterRunnerNames, jupyterVersion, showKernelSelector])
  const selectedKernelKey = useMemo(() => {
    const serverName =
      (cell?.metadata?.[RunmeMetadataKey.JupyterServerName] as
        | string
        | undefined) ?? ''
    const kernelID =
      (cell?.metadata?.[RunmeMetadataKey.JupyterKernelID] as
        | string
        | undefined) ?? ''
    if (!serverName || !kernelID) {
      return ''
    }
    const runnerName =
      (cell?.metadata?.[RunmeMetadataKey.RunnerName] as string | undefined) ??
      ''
    if (runnerName && !isAppKernelRunnerName(runnerName)) {
      return jupyterManager.getKernelOptionKey(serverName, kernelID, runnerName)
    }
    if (resolvedRunnerName) {
      return jupyterManager.getKernelOptionKey(
        serverName,
        kernelID,
        resolvedRunnerName
      )
    }
    return jupyterManager.getKernelOptionKey(serverName, kernelID)
  }, [cell, jupyterManager, resolvedRunnerName])

  useEffect(() => {
    if (readOnly) {
      return
    }
    if (selectedLanguage !== 'jupyter') {
      return
    }
    if (selectedKernelKey) {
      return
    }
    if (kernelOptions.length !== 1) {
      return
    }
    const option = kernelOptions[0]
    const parsed = jupyterManager.parseKernelOptionKey(option.key)
    if (!parsed) {
      return
    }
    cellData.setJupyterKernel({
      runnerName: option.runnerName,
      serverName: parsed.serverName,
      kernelId: parsed.kernelId,
      kernelName: option.label,
    })
  }, [
    cellData,
    jupyterManager,
    kernelOptions,
    readOnly,
    selectedKernelKey,
    selectedLanguage,
  ])

  const renderedOutputs = useMemo(() => {
    const hasTerminalOutput = (cell?.outputs ?? []).some((output) =>
      (output.items ?? []).some(
        (item) => item.mime === MimeType.StatefulRunmeTerminal
      )
    )
    const hasActiveStream = Boolean(cellData.getStreams())
    if (!hasTerminalOutput && !hasActiveStream) {
      return null
    }

    return (
      <CellConsole
        key={`console-${cell?.refId ?? 'cell'}-${runID}`}
        cellData={cellData}
        onPid={setPid}
        onExitCode={handleExitCode}
      />
    )
  }, [cell, cellData, handleExitCode, runID])

  const renderedOutputItems = useMemo(() => {
    if (!cell?.outputs || cell.outputs.length === 0) {
      return null
    }
    return (
      <ActionOutputItems
        outputs={cell.outputs}
        suppressStdText={Boolean(cellData.getStreams())}
      />
    )
  }, [cell?.outputs, cellData])

  const handleLanguageChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      if (!cell) {
        return
      }
      if (readOnly) {
        return
      }
      const nextValue = event.target
        .value as (typeof LANGUAGE_OPTIONS)[number]['value']
      if (nextValue === selectedLanguage) {
        return
      }

      const updatedCell = create(parser_pb.CellSchema, cell)
      updatedCell.metadata ??= {}
      const clearRuntimeMetadata = () => {
        delete updatedCell.metadata[RunmeMetadataKey.RunnerName]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName]
      }
      if (nextValue === 'markdown') {
        setMarkdownEditRequest((request) => request + 1)
        updatedCell.kind = parser_pb.CellKind.MARKUP
        updatedCell.languageId = 'markdown'
        clearRuntimeMetadata()
      } else if (nextValue === 'html') {
        setHtmlEditRequest((request) => request + 1)
        updatedCell.kind = parser_pb.CellKind.CODE
        updatedCell.languageId = 'html'
        clearRuntimeMetadata()
      } else if (nextValue === 'jupyter') {
        updatedCell.kind = parser_pb.CellKind.CODE
        updatedCell.languageId = 'jupyter'
        clearRuntimeMetadata()
      } else if (nextValue === 'javascript') {
        updatedCell.kind = parser_pb.CellKind.CODE
        updatedCell.languageId = 'javascript'
        updatedCell.metadata[RunmeMetadataKey.RunnerName] =
          APPKERNEL_RUNNER_NAME
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName]
      } else if (nextValue === 'python') {
        updatedCell.kind = parser_pb.CellKind.CODE
        updatedCell.languageId = 'python'
        if (
          isAppKernelRunnerName(
            updatedCell.metadata[RunmeMetadataKey.RunnerName]
          )
        ) {
          delete updatedCell.metadata[RunmeMetadataKey.RunnerName]
        }
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName]
      } else {
        updatedCell.kind = parser_pb.CellKind.CODE
        updatedCell.languageId = 'bash'
        if (
          isAppKernelRunnerName(
            updatedCell.metadata[RunmeMetadataKey.RunnerName]
          )
        ) {
          delete updatedCell.metadata[RunmeMetadataKey.RunnerName]
        }
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID]
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName]
      }

      updateCellLocal(updatedCell)
      setPid(null)
      setExitCode(null)
    },
    [cell, readOnly, selectedLanguage, updateCellLocal]
  )

  // Determine if this cell is a markdown cell (either MARKUP kind or CODE with markdown language)
  const isMarkdownCell = useMemo(() => {
    if (!cell) return false
    if (cell.kind === parser_pb.CellKind.MARKUP) return true
    return isMarkdownLanguageId(cell.languageId)
  }, [cell])
  const isHtmlCell = useMemo(() => {
    if (!cell) return false
    return (
      cell.kind === parser_pb.CellKind.CODE && isHtmlLanguageId(cell.languageId)
    )
  }, [cell])

  if (!cell) {
    return null
  }

  const cellCommentVisibilityClass =
    commentCount > 0 || (isActiveCell && isWindowFocused)
      ? 'opacity-100'
      : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/cell:pointer-events-auto group-hover/cell:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
  const cellLinkVisibilityClass = isActiveCell
    ? 'opacity-100'
    : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/cell:pointer-events-auto group-hover/cell:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
  const deepLinkTargetClass = isDeepLinkTarget
    ? 'rounded-nb-md outline outline-2 outline-offset-2 outline-nb-accent'
    : ''
  const contextMenuLinkLabel = isDriveItemUri(shareTargetUri ?? undefined)
    ? 'Copy link to cell'
    : 'Copy local link to cell'
  const canCopyCellLink = Boolean(shareTargetUri && cell.refId.trim())

  // Render markdown cells with in-place rendering (Jupyter-style)
  // No run button, no output area - just the markdown rendered in-place
  if (isMarkdownCell) {
    return (
      <div
        id={`markdown-action-${cell.refId}`}
        className={`group/cell relative flex min-w-0 ${deepLinkTargetClass}`}
        onContextMenu={handleContextMenu}
        onFocusCapture={handleFocusCapture}
        data-testid="markdown-action"
        data-cell-ref-id={cell.refId}
      >
        {/* Left gutter: top + bottom add-cell buttons */}
        <div
          id={`markdown-gutter-${cell.refId}`}
          className="flex w-7 shrink-0 flex-col items-center justify-between py-1"
        >
          <button
            type="button"
            aria-label="Add cell above"
            className="cell-add-btn h-5 w-5"
            disabled={readOnly}
            onClick={handleAddCellBefore}
          >
            <PlusIcon width={10} height={10} />
          </button>
          <button
            type="button"
            aria-label="Add cell below"
            className="cell-add-btn h-5 w-5"
            disabled={readOnly}
            onClick={handleAddCellAfter}
          >
            <PlusIcon width={10} height={10} />
          </button>
        </div>
        {/* Cell content */}
        <div className="min-w-0 flex-1">
          <div className="relative w-full min-w-0 max-w-full overflow-hidden">
            <MarkdownCell
              cellData={cellData}
              selectedLanguage={selectedLanguage}
              languageSelectId={languageSelectId}
              languageOptions={LANGUAGE_OPTIONS}
              onLanguageChange={handleLanguageChange}
              forceEditRequest={markdownEditRequest}
              readOnly={readOnly}
              isActiveCell={isActiveCell}
              activeFocusRole={activeFocusRole}
              isWindowFocused={isWindowFocused}
              onFocusRoleChange={handleMarkdownFocusRoleChange}
            />
            <CellCommentButton
              count={commentCount}
              available={commentsAvailable}
              onClick={handleStartComment}
              className={`absolute right-10 top-2 h-6 w-6 ${cellCommentVisibilityClass}`}
            />
            {canCopyCellLink && (
              <CellLinkButton
                onClick={() => void handleCopyShareLink()}
                className={`absolute right-[4.5rem] top-2 h-6 w-6 ${cellLinkVisibilityClass}`}
              />
            )}
            {/* Trash icon on the right, visible on hover */}
            <button
              type="button"
              aria-label="Delete cell"
              className="icon-btn absolute right-2 top-2 h-6 w-6 opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100"
              disabled={readOnly}
              onClick={handleRemoveCell}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
        {adjustedContextMenu && (
          <div
            className="ctx-menu"
            style={{
              top: adjustedContextMenu.y,
              left: adjustedContextMenu.x,
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {canCopyCellLink && (
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCopyShareLink()
                }}
              >
                {contextMenuLinkLabel}
              </button>
            )}
            <button
              type="button"
              className="ctx-menu-item"
              disabled={!commentsAvailable}
              onClick={(event) => {
                event.stopPropagation()
                handleStartComment()
              }}
            >
              Add Comment
            </button>
            <button
              type="button"
              className="ctx-menu-item text-red-600"
              disabled={readOnly}
              onClick={(event) => {
                event.stopPropagation()
                handleRemoveCell()
              }}
            >
              Remove Cell
            </button>
          </div>
        )}
      </div>
    )
  }

  if (isHtmlCell) {
    return (
      <div
        id={`html-action-${cell.refId}`}
        className={`group/cell relative flex min-w-0 ${deepLinkTargetClass}`}
        onContextMenu={handleContextMenu}
        data-testid="html-action"
        data-cell-ref-id={cell.refId}
      >
        <div
          id={`html-gutter-${cell.refId}`}
          className="flex w-7 shrink-0 flex-col items-center justify-between py-1"
        >
          <button
            type="button"
            aria-label="Add cell above"
            className="cell-add-btn h-5 w-5"
            disabled={readOnly}
            onClick={handleAddCellBefore}
          >
            <PlusIcon width={10} height={10} />
          </button>
          <button
            type="button"
            aria-label="Add cell below"
            className="cell-add-btn h-5 w-5"
            disabled={readOnly}
            onClick={handleAddCellAfter}
          >
            <PlusIcon width={10} height={10} />
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative w-full min-w-0 max-w-full overflow-hidden">
            <HtmlCell
              cellData={cellData}
              selectedLanguage={selectedLanguage}
              languageSelectId={languageSelectId}
              languageOptions={LANGUAGE_OPTIONS}
              onLanguageChange={handleLanguageChange}
              forceEditRequest={htmlEditRequest}
              readOnly={readOnly}
            />
            <CellCommentButton
              count={commentCount}
              available={commentsAvailable}
              onClick={handleStartComment}
              className={`absolute right-10 top-2 h-6 w-6 ${cellCommentVisibilityClass}`}
            />
            {canCopyCellLink && (
              <CellLinkButton
                onClick={() => void handleCopyShareLink()}
                className={`absolute right-[4.5rem] top-2 h-6 w-6 ${cellLinkVisibilityClass}`}
              />
            )}
            <button
              type="button"
              aria-label="Delete cell"
              className="icon-btn absolute right-2 top-2 h-6 w-6 opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100"
              disabled={readOnly}
              onClick={handleRemoveCell}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
        {adjustedContextMenu && (
          <div
            className="ctx-menu"
            style={{
              top: adjustedContextMenu.y,
              left: adjustedContextMenu.x,
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {canCopyCellLink && (
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCopyShareLink()
                }}
              >
                {contextMenuLinkLabel}
              </button>
            )}
            <button
              type="button"
              className="ctx-menu-item"
              disabled={!commentsAvailable}
              onClick={(event) => {
                event.stopPropagation()
                handleStartComment()
              }}
            >
              Add Comment
            </button>
            <button
              type="button"
              className="ctx-menu-item text-red-600"
              disabled={readOnly}
              onClick={(event) => {
                event.stopPropagation()
                handleRemoveCell()
              }}
            >
              Remove Cell
            </button>
          </div>
        )}
      </div>
    )
  }

  // Render code cells as a unified Marimo-style card: editor + toolbar + output
  // are all inside one bordered container with a distinctive "paper" shadow.
  // The outer wrapper is a flex row: left gutter (add-cell buttons) + cell card.
  return (
    <div
      id={`code-action-${cell.refId}`}
      className={`group/cell relative flex ${deepLinkTargetClass}`}
      onContextMenu={handleContextMenu}
      onFocusCapture={handleFocusCapture}
      data-testid="code-action"
      data-cell-ref-id={cell.refId}
    >
      {/* Left gutter: top + bottom add-cell buttons */}
      <div
        id={`code-gutter-${cell.refId}`}
        className="flex w-7 shrink-0 flex-col items-center justify-between py-1"
      >
        <button
          type="button"
          aria-label="Add cell above"
          className="cell-add-btn h-5 w-5"
          disabled={readOnly}
          onClick={handleAddCellBefore}
        >
          <PlusIcon width={10} height={10} />
        </button>
        <button
          type="button"
          aria-label="Add cell below"
          className="cell-add-btn h-5 w-5"
          disabled={readOnly}
          onClick={handleAddCellAfter}
        >
          <PlusIcon width={10} height={10} />
        </button>
      </div>

      {/* Cell card: editor + toolbar + output */}
      <div className="min-w-0 flex-1">
        <div id={`cell-card-${cell.refId}`} className="cell-card">
          {/* Code editor section — overflow-hidden keeps border-radius clipping on the editor */}
          <div
            className="overflow-hidden rounded-t-nb-md"
            data-cell-focus-role="editor"
          >
            <Editor
              key={`editor-${cell.refId}-${selectedLanguage}`}
              id={cell.refId}
              value={cell.value}
              language={editorLanguage}
              fontSize={fontSettings.fontSize}
              fontFamily={fontSettings.fontFamily}
              shouldFocus={isActiveCell && isWindowFocused}
              readOnly={readOnly}
              onChange={(v) => {
                const updated = create(parser_pb.CellSchema, cell)
                updated.value = v
                updateCellLocal(updated)
              }}
              onEnter={runCode}
            />
          </div>

          {/* Minimal toolbar: language + runner selectors + run/trash buttons */}
          <div id={`cell-toolbar-${cell.refId}`} className="cell-toolbar">
            <div className="flex items-center gap-3">
              <select
                id={languageSelectId}
                value={selectedLanguage}
                onChange={handleLanguageChange}
                disabled={readOnly}
                className="toolbar-select"
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {showRunnerSelector && (
                <select
                  id={runnerSelectId}
                  value={runnerSelectValue}
                  onChange={(event) => {
                    if (readOnly) {
                      return
                    }
                    const nextName = event.target.value
                    if (isJavascriptLanguage) {
                      const validJsRunner = JAVASCRIPT_RUNNER_OPTIONS.some(
                        (option) => option.value === nextName
                      )
                      if (!validJsRunner) {
                        return
                      }
                      cellData.setRunner(nextName)
                      return
                    }
                    const names = new Set(listRunners().map((r) => r.name))
                    if (
                      !names.has(nextName) &&
                      nextName !== DEFAULT_RUNNER_PLACEHOLDER
                    ) {
                      return
                    }
                    cellData.setRunner(nextName)
                  }}
                  disabled={readOnly}
                  className="toolbar-select"
                >
                  {isJavascriptLanguage ? (
                    JAVASCRIPT_RUNNER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value={DEFAULT_RUNNER_PLACEHOLDER}>
                        {defaultRunnerName ? `${defaultRunnerName}` : 'default'}
                      </option>
                      {listRunners()
                        .filter((runner) => !isAppKernelRunnerName(runner.name))
                        .map((runner) => (
                          <option key={runner.name} value={runner.name}>
                            {runner.name}
                          </option>
                        ))}
                    </>
                  )}
                </select>
              )}
              {showKernelSelector && (
                <select
                  id={kernelSelectId}
                  value={selectedKernelKey}
                  onChange={(event) => {
                    if (readOnly) {
                      return
                    }
                    const nextKey = event.target.value
                    if (!nextKey) {
                      cellData.clearJupyterKernel()
                      return
                    }
                    const parsed = jupyterManager.parseKernelOptionKey(nextKey)
                    if (!parsed) {
                      return
                    }
                    const option = kernelOptions.find(
                      (item) => item.key === nextKey
                    )
                    if (!option) {
                      return
                    }
                    cellData.setJupyterKernel({
                      runnerName: option.runnerName,
                      serverName: parsed.serverName,
                      kernelId: parsed.kernelId,
                      kernelName: option.label,
                    })
                  }}
                  disabled={readOnly}
                  className="toolbar-select"
                >
                  <option value="">Select kernel</option>
                  {kernelOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              {sequenceLabel.trim() && (
                <span className="text-[11px] font-mono text-nb-text-faint">
                  [{sequenceLabel}]
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {canCopyCellLink && (
                <CellLinkButton
                  onClick={() => void handleCopyShareLink()}
                  className={`h-7 w-7 ${cellLinkVisibilityClass}`}
                />
              )}
              <CellCommentButton
                count={commentCount}
                available={commentsAvailable}
                onClick={handleStartComment}
                className={`relative h-7 w-7 ${cellCommentVisibilityClass}`}
              />
              <RunActionButton
                pid={pid}
                onClick={runCode}
                disabled={readOnly}
              />
              <button
                type="button"
                aria-label="Delete cell"
                className="icon-btn h-7 w-7 opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100"
                disabled={readOnly}
                onClick={handleRemoveCell}
              >
                <TrashIcon />
              </button>
            </div>
          </div>

          {/* Output section: separated by a thin divider, inside the same card.
              max-h + overflow-auto gives a vertical scrollbar when output is tall. */}
          {(renderedOutputs || renderedOutputItems) && (
            <div id={`cell-output-${cell.refId}`}>
              <div className="border-t border-nb-tray-border" />
              <div
                className="overflow-auto p-[14.4px]"
                style={{ maxHeight: 'var(--nb-cell-output-max-h)' }}
              >
                {renderedOutputs}
                {renderedOutputItems}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {adjustedContextMenu && (
        <div
          className="ctx-menu"
          style={{
            top: adjustedContextMenu.y,
            left: adjustedContextMenu.x,
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {canCopyCellLink && (
            <button
              type="button"
              className="ctx-menu-item"
              onClick={(event) => {
                event.stopPropagation()
                void handleCopyShareLink()
              }}
            >
              {contextMenuLinkLabel}
            </button>
          )}
          <button
            type="button"
            className="ctx-menu-item"
            disabled={!commentsAvailable}
            onClick={(event) => {
              event.stopPropagation()
              handleStartComment()
            }}
          >
            Add Comment
          </button>
          <button
            type="button"
            className="ctx-menu-item text-red-600"
            disabled={readOnly}
            onClick={(event) => {
              event.stopPropagation()
              handleRemoveCell()
            }}
          >
            Remove Cell
          </button>
        </div>
      )}
    </div>
  )
}

function NotebookTabContent({
  docUri,
  entry,
  activeCell,
  deepLinkCellId,
  isSelected,
  isWindowFocused,
  onCellFocus,
}: {
  docUri: string
  entry: OpenNotebookEntry
  activeCell: NotebookActiveCellState | null
  deepLinkCellId: string | null
  isSelected: boolean
  isWindowFocused: boolean
  onCellFocus: (docUri: string, state: NotebookActiveCellState) => void
}) {
  const {
    getNotebookData,
    refreshReadOnlyNotebook,
    requestWriteAccess,
    useNotebookSnapshot,
  } = useNotebookContext()
  const { store } = useNotebookStore()
  const notebookSnapshot = useNotebookSnapshot(docUri)
  const notebookData = notebookSnapshot
    ? getNotebookData(notebookSnapshot.uri)
    : null
  const notebookRootRef = useRef<HTMLDivElement | null>(null)
  const appliedDeepLinkRef = useRef<string | null>(null)
  const reportedMissingDeepLinkRef = useRef<string | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const [highlightedDeepLinkCellId, setHighlightedDeepLinkCellId] = useState<
    string | null
  >(null)
  const [embeddingImage, setEmbeddingImage] = useState(false)
  const [imageDragActive, setImageDragActive] = useState(false)
  const syncState = useNotebookSyncState(docUri)
  const releasePending = Boolean(
    entry.releasePending || notebookSnapshot?.releasePending
  )
  const readOnly = Boolean(
    entry.readOnly || notebookSnapshot?.readOnly || releasePending
  )
  const isDriveBacked = isDriveBackedNotebook(entry, syncState)
  const { commentsPanelOpen, openCommentsPanel, setCommentsPanelOpen } =
    useCommentsPanel()
  const shouldRenderCells = !readOnly || isSelected
  const cellDatas = useMemo(() => {
    if (!shouldRenderCells) {
      return []
    }
    if (!notebookSnapshot) {
      return []
    }
    if (!notebookData) {
      return []
    }
    return (notebookSnapshot.notebook.cells ?? [])
      .map((c) => (c?.refId ? notebookData.getCell(c.refId) : null))
      .filter((c): c is CellData => Boolean(c))
  }, [notebookData, notebookSnapshot, shouldRenderCells])
  const [commentsRemoteUri, setCommentsRemoteUri] = useState<string | null>(
    null
  )
  const [commentsStatus, setCommentsStatus] = useState<
    'loading' | 'available' | 'unavailable' | 'error'
  >('loading')
  const [commentsErrorMessage, setCommentsErrorMessage] = useState<
    string | undefined
  >()
  const [comments, setComments] = useState<DriveComment[]>([])
  const [commentsBusy, setCommentsBusy] = useState(false)
  const [draftCellId, setDraftCellId] = useState<string | null>(null)
  const cellLabels = useMemo(() => {
    const labels = new Map<string, string>()
    cellDatas.forEach((cellData, index) => {
      const refId = cellData.snapshot?.refId
      if (refId) {
        labels.set(refId, `Cell ${index + 1}`)
      }
    })
    return labels
  }, [cellDatas])
  const commentsByCell = useMemo(
    () => groupCommentsByCell(comments),
    [comments]
  )
  const commentThreads = useMemo(
    () => toCellCommentThreads(comments, new Set(cellLabels.keys())),
    [cellLabels, comments]
  )

  const findCellElement = useCallback((cellId: string) => {
    const elements =
      notebookRootRef.current?.querySelectorAll<HTMLElement>(
        '[data-cell-ref-id]'
      ) ?? []
    return (
      Array.from(elements).find(
        (element) => element.dataset.cellRefId === cellId
      ) ?? null
    )
  }, [])

  const selectCommentCell = useCallback(
    (cellId: string) => {
      const element = findCellElement(cellId)
      const focusRole = element?.id.startsWith('markdown-action-')
        ? 'rendered'
        : 'editor'
      const nextState = createNotebookActiveCellState(cellId, focusRole)
      if (nextState) {
        onCellFocus(docUri, nextState)
      }
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
    [docUri, findCellElement, onCellFocus]
  )

  const embedImageFiles = useCallback(
    async (files: File[]) => {
      if (readOnly || !notebookData || files.length === 0) {
        return
      }
      setEmbeddingImage(true)
      try {
        for (const file of files) {
          await embedImageInNotebook(notebookData, file)
        }
        showToast({
          message:
            files.length === 1
              ? `Embedded ${files[0]?.name || 'image'}.`
              : `Embedded ${files.length} images.`,
          tone: 'success',
        })
      } catch (error) {
        showToast({
          message: `Failed to embed image: ${String(error)}`,
          tone: 'error',
        })
      } finally {
        setEmbeddingImage(false)
      }
    },
    [notebookData, readOnly]
  )

  const handleEmbedImage = useCallback(async () => {
    try {
      const file = await pickImageFromLocalFilesystem()
      if (file) {
        await embedImageFiles([file])
      }
    } catch (error) {
      showToast({
        message: `Failed to select image: ${String(error)}`,
        tone: 'error',
      })
    }
  }, [embedImageFiles])

  const handleImageDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (readOnly) {
        return
      }
      const hasImageCandidate = Array.from(event.dataTransfer.items).some(
        (item) =>
          item.kind === 'file' &&
          (!item.type || item.type.toLowerCase().startsWith('image/'))
      )
      if (!hasImageCandidate) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setImageDragActive(true)
    },
    [readOnly]
  )

  const handleImageDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return
      }
      setImageDragActive(false)
    },
    []
  )

  const handleImageDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) {
        event.preventDefault()
      }
      setImageDragActive(false)
      if (readOnly) {
        return
      }
      const images = files.filter(isSupportedImageFile)
      if (images.length === 0) {
        return
      }
      void embedImageFiles(images)
    },
    [embedImageFiles, readOnly]
  )

  const startCommentDraft = useCallback(
    (cellId: string) => {
      openCommentsPanel()
      setDraftCellId(cellId)
      selectCommentCell(cellId)
    },
    [openCommentsPanel, selectCommentCell]
  )

  const refreshComments = useCallback(async () => {
    const driveStore = appState.driveNotebookStore
    if (!commentsRemoteUri || !driveStore) {
      setComments([])
      setCommentsStatus('unavailable')
      setCommentsErrorMessage(undefined)
      return
    }

    setCommentsStatus('loading')
    setCommentsErrorMessage(undefined)
    try {
      const nextComments = await driveStore.listComments(commentsRemoteUri)
      setComments(nextComments)
      setCommentsStatus('available')
    } catch (error) {
      setComments([])
      setCommentsStatus('error')
      setCommentsErrorMessage(String(error))
    }
  }, [commentsRemoteUri])

  useEffect(() => {
    let cancelled = false
    setDraftCellId(null)
    setCommentsErrorMessage(undefined)

    void (async () => {
      if (!notebookSnapshot?.loaded) {
        if (!cancelled) {
          setCommentsRemoteUri(null)
          setCommentsStatus('loading')
        }
        return
      }

      if (isDriveItemUri(docUri)) {
        if (!cancelled) {
          setCommentsRemoteUri(docUri)
          setCommentsStatus('loading')
        }
        return
      }

      if (!store || !docUri.startsWith('local://')) {
        if (!cancelled) {
          setCommentsRemoteUri(null)
          setComments([])
          setCommentsStatus('unavailable')
        }
        return
      }

      try {
        const metadata = await store.getMetadata(docUri)
        const remoteUri = metadata?.remoteUri
        if (!cancelled) {
          if (remoteUri && isDriveItemUri(remoteUri)) {
            setCommentsRemoteUri(remoteUri)
            setCommentsStatus('loading')
          } else {
            setCommentsRemoteUri(null)
            setComments([])
            setCommentsStatus('unavailable')
          }
        }
      } catch {
        if (!cancelled) {
          setCommentsRemoteUri(null)
          setComments([])
          setCommentsStatus('unavailable')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [docUri, notebookSnapshot?.loaded, store])

  useEffect(() => {
    void refreshComments()
  }, [refreshComments])

  const handleCreateComment = useCallback(
    async (cellId: string, content: string) => {
      const driveStore = appState.driveNotebookStore
      if (!commentsRemoteUri || !driveStore) {
        showToast({
          tone: 'error',
          message: 'Comments are only available for Google Drive notebooks.',
        })
        return
      }
      setCommentsBusy(true)
      try {
        await driveStore.createComment(
          commentsRemoteUri,
          content,
          createCellCommentAnchor(cellId)
        )
        setDraftCellId(null)
        await refreshComments()
      } catch (error) {
        showToast({
          tone: 'error',
          message: `Failed to create comment: ${String(error)}`,
        })
      } finally {
        setCommentsBusy(false)
      }
    },
    [commentsRemoteUri, refreshComments]
  )

  const handleReplyToComment = useCallback(
    async (commentId: string, content: string) => {
      const driveStore = appState.driveNotebookStore
      if (!commentsRemoteUri || !driveStore) {
        return
      }
      setCommentsBusy(true)
      try {
        await driveStore.replyToComment(commentsRemoteUri, commentId, content)
        await refreshComments()
      } catch (error) {
        showToast({
          tone: 'error',
          message: `Failed to reply to comment: ${String(error)}`,
        })
      } finally {
        setCommentsBusy(false)
      }
    },
    [commentsRemoteUri, refreshComments]
  )

  const handleResolveComment = useCallback(
    async (commentId: string) => {
      const driveStore = appState.driveNotebookStore
      if (!commentsRemoteUri || !driveStore) {
        return
      }
      setCommentsBusy(true)
      try {
        await driveStore.resolveComment(commentsRemoteUri, commentId)
        await refreshComments()
      } catch (error) {
        showToast({
          tone: 'error',
          message: `Failed to resolve comment: ${String(error)}`,
        })
      } finally {
        setCommentsBusy(false)
      }
    },
    [commentsRemoteUri, refreshComments]
  )

  const handleReopenComment = useCallback(
    async (commentId: string) => {
      const driveStore = appState.driveNotebookStore
      if (!commentsRemoteUri || !driveStore) {
        return
      }
      setCommentsBusy(true)
      try {
        await driveStore.reopenComment(commentsRemoteUri, commentId)
        await refreshComments()
      } catch (error) {
        showToast({
          tone: 'error',
          message: `Failed to reopen comment: ${String(error)}`,
        })
      } finally {
        setCommentsBusy(false)
      }
    },
    [commentsRemoteUri, refreshComments]
  )

  useEffect(() => {
    if (!deepLinkCellId) {
      appliedDeepLinkRef.current = null
      reportedMissingDeepLinkRef.current = null
      setHighlightedDeepLinkCellId(null)
      return
    }
    if (!isSelected || !notebookSnapshot?.loaded) {
      return
    }

    const applicationKey = JSON.stringify([docUri, deepLinkCellId])
    if (appliedDeepLinkRef.current === applicationKey) {
      return
    }

    const element = findCellElement(deepLinkCellId)
    if (!element) {
      if (
        syncState?.status !== 'syncing' &&
        reportedMissingDeepLinkRef.current !== applicationKey
      ) {
        showToast({
          message: 'The linked cell no longer exists in this notebook.',
          tone: 'error',
        })
        reportedMissingDeepLinkRef.current = applicationKey
      }
      return
    }

    element.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'auto',
    })
    appliedDeepLinkRef.current = applicationKey
    reportedMissingDeepLinkRef.current = null
    setHighlightedDeepLinkCellId(deepLinkCellId)
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current)
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedDeepLinkCellId(null)
      highlightTimeoutRef.current = null
    }, 2_000)
  }, [
    cellDatas,
    deepLinkCellId,
    docUri,
    findCellElement,
    isSelected,
    notebookSnapshot?.loaded,
    syncState?.status,
  ])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
    }
  }, [])

  if (readOnly && !isSelected) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-nb-text-muted"
        data-testid="notebook-readonly-inactive-state"
      >
        <LockClosedIcon className="h-4 w-4 text-nb-text-muted" />
        <span>Read-only notebook content will load when selected.</span>
      </div>
    )
  }

  if (entry.state === 'blocked') {
    const ownerSessionId = getNotebookOwnerSessionId(entry.owner)
    const ownerText = entry.owner?.ownerStartedAt
      ? `Tab opened at ${new Date(entry.owner.ownerStartedAt).toLocaleTimeString()}`
      : 'Another browser tab'
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center text-sm text-nb-text-muted"
        data-testid="notebook-blocked-state"
      >
        <div className="space-y-2">
          <Text size="4" weight="bold" as="p" className="text-nb-text">
            Notebook is already open in another browser tab
          </Text>
          <Text size="2" as="p">
            {entry.name}
          </Text>
          <Text size="2" as="p">
            Owned by: {ownerText}
          </Text>
          {ownerSessionId && (
            <Text size="2" as="p">
              Open in session: {ownerSessionId}
            </Text>
          )}
          <Text size="2" as="p">
            Request write access to save the other tab and switch it to
            read-only.
          </Text>
          {entry.writeAccessErrorMessage && (
            <Text size="2" as="p" color="red">
              {entry.writeAccessErrorMessage}
            </Text>
          )}
        </div>
        <Button
          variant="soft"
          disabled={entry.writeAccessRequestState === 'pending'}
          onClick={() => {
            void requestWriteAccess(docUri)
          }}
        >
          {entry.writeAccessRequestState === 'pending'
            ? 'Requesting write access...'
            : 'Request write access'}
        </Button>
      </div>
    )
  }

  if (entry.state === 'error') {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-nb-text-muted"
        data-testid="notebook-error-state"
      >
        <Text size="4" weight="bold" as="p" className="text-nb-text">
          Notebook could not be opened
        </Text>
        <Text size="2" as="p">
          {entry.errorMessage ?? 'An unknown error occurred.'}
        </Text>
      </div>
    )
  }

  if (!notebookSnapshot || !notebookSnapshot.loaded) {
    if (isDriveBacked) {
      return <NotebookDriveLoadingState />
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-nb-text-muted">
        <span>Loading…</span>
      </div>
    )
  }

  const data = notebookData
  const ownerSessionId = getNotebookOwnerSessionId(entry.owner)

  if (
    cellDatas.length === 0 &&
    isDriveBacked &&
    syncState?.status === 'syncing'
  ) {
    return <NotebookDriveLoadingState />
  }

  return (
    <div
      ref={notebookRootRef}
      className="relative flex h-full min-w-0"
      data-testid="notebook-content"
      onDragOver={handleImageDragOver}
      onDragLeave={handleImageDragLeave}
      onDrop={handleImageDrop}
    >
      {imageDragActive && (
        <div
          className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-nb-md border-2 border-dashed border-nb-accent bg-nb-accent-muted/90 text-sm font-medium text-nb-accent"
          data-testid="image-drop-target"
        >
          Drop image to embed
        </div>
      )}
      <ScrollArea
        key={`scroll-${docUri}`}
        type="auto"
        scrollbars="both"
        className="h-full min-w-0 max-w-full flex-1"
        data-document-id={docUri}
      >
        {/* Full-width notebook column with horizontal padding for breathing room.
            Cells expand to fill the available width of the tab content area. */}
        <div id="notebook-column" className="w-full py-2 px-8">
          {releasePending ? (
            <div
              className="mb-3 flex items-center gap-2 rounded-nb-sm border border-nb-border bg-nb-surface-2 px-3 py-2 text-xs text-nb-text-muted"
              data-testid="notebook-owner-locked-banner"
            >
              <LockClosedIcon className="h-4 w-4 text-nb-text-muted" />
              <span>
                Another session requested write access. Saving changes and
                switching this notebook to read-only.
              </span>
            </div>
          ) : readOnly ? (
            <div
              className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-nb-sm border border-nb-border bg-nb-surface-2 px-3 py-2 text-xs text-nb-text-muted"
              data-testid="notebook-readonly-banner"
            >
              <div className="flex min-w-0 items-center gap-2">
                <LockClosedIcon className="h-4 w-4 shrink-0 text-nb-text-muted" />
                <div className="min-w-0">
                  <p>
                    {ownerSessionId
                      ? `Read-only. This notebook is open for editing in session ${ownerSessionId}.`
                      : 'Read-only. This notebook is open for editing in another browser tab.'}
                  </p>
                  {entry.writeAccessErrorMessage && (
                    <p className="mt-1 text-red-600">
                      {entry.writeAccessErrorMessage}
                    </p>
                  )}
                  {entry.refreshErrorMessage && (
                    <p className="mt-1 text-red-600">
                      {entry.refreshErrorMessage}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {entry.refreshErrorMessage && (
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => void refreshReadOnlyNotebook(docUri)}
                  >
                    Refresh
                  </Button>
                )}
                <Button
                  size="1"
                  variant="soft"
                  disabled={entry.writeAccessRequestState === 'pending'}
                  onClick={() => void requestWriteAccess(docUri)}
                >
                  {entry.writeAccessRequestState === 'pending'
                    ? 'Requesting...'
                    : 'Request write access'}
                </Button>
              </div>
            </div>
          ) : null}
          {cellDatas.length === 0 ? (
            <div
              id="empty-notebook-prompt"
              className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-nb-text-muted"
            >
              <p>
                {readOnly
                  ? 'This read-only notebook has no cells.'
                  : 'This notebook has no cells yet.'}
              </p>
              {!readOnly && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="cell-add-btn h-8 w-8"
                    aria-label="Add first cell"
                    onClick={() => data?.appendCell(parser_pb.CellKind.MARKUP)}
                  >
                    <PlusIcon className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-full border border-nb-border-strong bg-white px-3 py-1 text-xs text-nb-text-muted transition-colors duration-150 hover:border-nb-accent hover:text-nb-accent hover:bg-nb-accent-muted disabled:cursor-wait disabled:opacity-60"
                    aria-label="Embed image as first cell"
                    disabled={embeddingImage}
                    onClick={() => void handleEmbedImage()}
                  >
                    <PhotoIcon className="h-3.5 w-3.5" />
                    <span>{embeddingImage ? 'Embedding…' : 'Embed image'}</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {cellDatas.map((cellData, index) => {
                const refId = cellData.snapshot?.refId ?? `cell-${index}`
                return (
                  <Action
                    key={`action-${refId}`}
                    cellData={cellData}
                    docUri={docUri}
                    isFirst={index === 0}
                    isActiveCell={activeCell?.refId === refId}
                    activeFocusRole={activeCell?.focusRole ?? 'editor'}
                    isWindowFocused={isWindowFocused}
                    isDeepLinkTarget={highlightedDeepLinkCellId === refId}
                    onFocusStateChange={(state) => onCellFocus(docUri, state)}
                    readOnly={readOnly}
                    commentsAvailable={commentsStatus === 'available'}
                    commentCount={commentsByCell.get(refId)?.length ?? 0}
                    onStartComment={startCommentDraft}
                  />
                )
              })}
              {!readOnly && (
                <div className="flex justify-center gap-2 py-3">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-full border border-nb-border-strong bg-white px-3 py-1 text-xs text-nb-text-muted transition-colors duration-150 hover:border-nb-accent hover:text-nb-accent hover:bg-nb-accent-muted"
                    aria-label="Add cell at end"
                    onClick={() => data?.appendCell(parser_pb.CellKind.CODE)}
                  >
                    <PlusIcon width={10} height={10} />
                    <span>Add cell</span>
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-full border border-nb-border-strong bg-white px-3 py-1 text-xs text-nb-text-muted transition-colors duration-150 hover:border-nb-accent hover:text-nb-accent hover:bg-nb-accent-muted disabled:cursor-wait disabled:opacity-60"
                    aria-label="Embed image at end"
                    disabled={embeddingImage}
                    onClick={() => void handleEmbedImage()}
                  >
                    <PhotoIcon className="h-3.5 w-3.5" />
                    <span>{embeddingImage ? 'Embedding…' : 'Embed image'}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
      {commentsPanelOpen && (
        <NotebookCommentsPanel
          status={commentsStatus}
          errorMessage={commentsErrorMessage}
          threads={commentThreads}
          cellLabels={cellLabels}
          activeCellId={activeCell?.refId ?? null}
          draftCellId={draftCellId}
          busy={commentsBusy}
          onCancelDraft={() => setDraftCellId(null)}
          onCreateComment={handleCreateComment}
          onReply={handleReplyToComment}
          onResolve={handleResolveComment}
          onReopen={handleReopenComment}
          onRefresh={refreshComments}
          onHide={() => setCommentsPanelOpen(false)}
          onSelectCell={selectCommentCell}
        />
      )}
    </div>
  )
}

function NotebookDiffTabContent({ diffUri }: { diffUri: string }) {
  const diffId = diffUri.slice('diff://notebook/'.length)
  const decodedDiffId = diffId ? decodeURIComponent(diffId) : ''
  const [, setDiffDocumentVersion] = useState(0)
  useEffect(() => {
    if (!decodedDiffId || typeof window === 'undefined') {
      return
    }
    const onDiffDocumentChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail
      if (detail?.id === decodedDiffId) {
        setDiffDocumentVersion((version) => version + 1)
      }
    }
    window.addEventListener(
      NOTEBOOK_DIFF_DOCUMENT_CHANGED,
      onDiffDocumentChanged
    )
    return () => {
      window.removeEventListener(
        NOTEBOOK_DIFF_DOCUMENT_CHANGED,
        onDiffDocumentChanged
      )
    }
  }, [decodedDiffId])

  const document = decodedDiffId ? getNotebookDiffDocument(decodedDiffId) : null
  if (document) {
    return <NotebookDiffContent document={document} />
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-nb-text-muted">
      <Text size="3" weight="bold" as="p" className="text-nb-text">
        Diff no longer available
      </Text>
      <Text size="2" as="p">
        Recompute the notebook diff from a browser JavaScript cell, then call
        notebookDiff.openDiffTab(diff) again.
      </Text>
    </div>
  )
}

function UnknownDocumentTab({ uri }: { uri: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-nb-text-muted">
      <Text size="3" weight="bold" as="p" className="text-nb-text">
        Unsupported document
      </Text>
      <Text size="2" as="p">
        {uri}
      </Text>
    </div>
  )
}

function renderWorkspaceDocument({
  document,
  activeCell,
  deepLinkCellId,
  isSelected,
  isWindowFocused,
  onCellFocus,
  onDriveLogin,
  onDriveRetry,
}: {
  document: WorkspaceDocument
  activeCell: NotebookActiveCellState | null
  deepLinkCellId: string | null
  isSelected: boolean
  isWindowFocused: boolean
  onCellFocus: (docUri: string, state: NotebookActiveCellState) => void
  onDriveLogin: () => void
  onDriveRetry: () => void
}) {
  if (isExcalidrawWorkspaceDocument(document)) {
    return <ExcalidrawDocument document={document} />
  }

  if (isNotebookDocumentUri(document.uri)) {
    const entry: OpenNotebookEntry = {
      uri: document.uri,
      requestedUri: document.requestedUri ?? document.uri,
      name: document.title,
      state: document.state ?? 'loading',
      readOnly: document.readOnly,
      releasePending: document.releasePending,
      writeAccessRequestState: document.writeAccessRequestState,
      writeAccessErrorMessage: document.writeAccessErrorMessage,
      refreshErrorMessage: document.refreshErrorMessage,
      errorMessage: document.errorMessage,
      ...(document.owner !== undefined ? { owner: document.owner } : {}),
    }
    return (
      <NotebookTabContent
        docUri={document.uri}
        entry={entry}
        activeCell={activeCell}
        deepLinkCellId={deepLinkCellId}
        isSelected={isSelected}
        isWindowFocused={isWindowFocused}
        onCellFocus={onCellFocus}
      />
    )
  }

  if (isNotebookDiffUri(document.uri)) {
    return <NotebookDiffTabContent diffUri={document.uri} />
  }

  if (isDriveLinkStatusUri(document.uri)) {
    return <DriveLinkStatusTab onLogin={onDriveLogin} onRetry={onDriveRetry} />
  }

  if (isDriveSyncStatusUri(document.uri)) {
    return <DriveSyncStatusTab />
  }

  if (isVersionInfoUri(document.uri)) {
    return <VersionInfoTab />
  }

  if (isRunnerStatusUri(document.uri)) {
    return <RunnerStatusTab />
  }

  if (isAppConsoleUri(document.uri)) {
    return <AppConsole showHeader={false} />
  }

  if (isLogsUri(document.uri)) {
    return <LogsPane />
  }

  return <UnknownDocumentTab uri={document.uri} />
}

export default function Actions() {
  const { useWorkspaceDocuments, showDocument, closeWorkspaceDocument } =
    useWorkspaceDocumentContext()
  const { getNotebookData } = useNotebookContext()
  const { store } = useNotebookStore()
  const workspaceDocuments = useWorkspaceDocuments()
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()
  const currentDocUri = getCurrentDoc()
  const driveLinkSnapshot = useDriveLinkCoordinatorSnapshot()
  const statusTabVisible =
    driveLinkSnapshot.intents.length > 0 ||
    Boolean(driveLinkSnapshot.lastErrorMessage)
  const [selectedTabUri, setSelectedTabUri] = useState<string | null>(null)
  const [activeCellsByDoc, setActiveCellsByDoc] =
    useState<NotebookActiveCellMap>(() => loadNotebookActiveCellMap())
  const [deepLinkCellId, setDeepLinkCellId] = useState<string | null>(() =>
    typeof window === 'undefined'
      ? null
      : parseNotebookCellFragment(window.location.hash)
  )
  const [deepLinkRequestedDocUri, setDeepLinkRequestedDocUri] = useState<
    string | null
  >(() =>
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('doc')?.trim() || null
  )
  const [deepLinkTargetDocUri, setDeepLinkTargetDocUri] = useState<
    string | null
  >(null)
  const [isWindowFocused, setIsWindowFocused] = useState(() => {
    if (typeof document === 'undefined') {
      return false
    }
    return document.visibilityState === 'visible' && document.hasFocus()
  })
  // Empty-state hint visibility is stored locally so the hint panel can be
  // revealed on demand without cluttering the default view.
  const [showConsoleHints, setShowConsoleHints] = useState(false)
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number
    y: number
    docUri: string
    title: string
    shareableUri: string
    googleDriveUri: string | null
    ownerSessionId: string | null
    canOpenUpstreamDiff: boolean
    readOnly?: boolean
  } | null>(null)
  const tabTriggerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const pendingSelectedTabUriRef = useRef<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const syncCellFragment = () => {
      setDeepLinkCellId(parseNotebookCellFragment(window.location.hash))
      setDeepLinkRequestedDocUri(
        new URLSearchParams(window.location.search).get('doc')?.trim() || null
      )
      setDeepLinkTargetDocUri(null)
    }
    window.addEventListener('hashchange', syncCellFragment)
    window.addEventListener('popstate', syncCellFragment)
    return () => {
      window.removeEventListener('hashchange', syncCellFragment)
      window.removeEventListener('popstate', syncCellFragment)
    }
  }, [])
  //const { data: run } = useRun(runName);

  // useEffect(() => {
  //   if (cellsInitialized) {
  //     return;
  //   }
  //   if (run) {
  //     const fallbackName = run?.name ?? runName ?? "Run Notebook";
  //     const targetUri =
  //       currentDocUri ??
  //       (runName ? `run:${runName}` : "run-notebook");
  //     const notebook = create(parser_pb.NotebookSchema, {
  //       cells: run.notebook?.cells ?? [],
  //       metadata: run.notebook?.metadata ?? {},
  //     });
  //     const data = ensureNotebook({
  //       uri: targetUri,
  //       name: fallbackName,
  //       notebook,
  //     });
  //     data.loadNotebook(notebook);
  //     data.setName(fallbackName);
  //     console.log("useEffect is calling setCurrentDoc because run is true", targetUri);
  //     setCurrentDoc(targetUri);
  //     setCellsInitialized(true);
  //   }
  // }, [cellsInitialized, currentDocUri, ensureNotebook, run, runName, setCurrentDoc]);

  const { registerRenderer, unregisterRenderer } = useOutput()
  const workspaceDocumentUris = useMemo(
    () => new Set(workspaceDocuments.map((document) => document.uri)),
    [workspaceDocuments]
  )
  const selectedTabIsOpen = selectedTabUri
    ? workspaceDocumentUris.has(selectedTabUri)
    : false
  const currentDocIsOpen = currentDocUri
    ? workspaceDocumentUris.has(currentDocUri)
    : false
  const resolvedSelectedTabUri =
    (selectedTabIsOpen ? selectedTabUri : null) ??
    (currentDocIsOpen ? currentDocUri : null) ??
    workspaceDocuments[0]?.uri ??
    ''
  const urlHasDocParam =
    typeof window !== 'undefined' &&
    Boolean(new URLSearchParams(window.location.search).get('doc')?.trim())
  const hasPendingUrlDocIntent = driveLinkSnapshot.intents.some(
    (intent) => intent.source === 'url'
  )

  useEffect(() => {
    if (!deepLinkCellId) {
      setDeepLinkTargetDocUri(null)
      return
    }
    const targetDocUri = deepLinkRequestedDocUri
      ? currentDocUri
      : resolvedSelectedTabUri
    if (
      deepLinkTargetDocUri ||
      !targetDocUri ||
      (deepLinkRequestedDocUri && !currentDocIsOpen)
    ) {
      return
    }
    if (
      deepLinkRequestedDocUri &&
      (urlHasDocParam ||
        hasPendingUrlDocIntent ||
        Boolean(driveLinkSnapshot.lastErrorMessage))
    ) {
      return
    }
    setDeepLinkTargetDocUri(targetDocUri)
  }, [
    currentDocIsOpen,
    currentDocUri,
    deepLinkCellId,
    deepLinkRequestedDocUri,
    deepLinkTargetDocUri,
    driveLinkSnapshot.lastErrorMessage,
    hasPendingUrlDocIntent,
    resolvedSelectedTabUri,
    urlHasDocParam,
  ])

  const handleCellFocus = useCallback(
    (docUri: string, state: NotebookActiveCellState) => {
      setActiveCellsByDoc((prev) => {
        const current = prev[docUri]
        if (
          current?.refId === state.refId &&
          current.focusRole === state.focusRole
        ) {
          return prev
        }
        const next = {
          ...prev,
          [docUri]: state,
        }
        persistNotebookActiveCellMap(next)
        return next
      })
    },
    []
  )

  // Keep Radix tab selection in sync with the shared current document URI.
  // CurrentDocContext may restore a non-restorable URI, such as a diff/status
  // document. Fall back to the first restored workspace document in that case.
  useEffect(() => {
    if (statusTabVisible) {
      return
    }
    const pendingSelectedTabUri = pendingSelectedTabUriRef.current
    if (pendingSelectedTabUri) {
      if (pendingSelectedTabUri === currentDocUri) {
        pendingSelectedTabUriRef.current = null
      } else if (workspaceDocumentUris.has(pendingSelectedTabUri)) {
        if (selectedTabUri !== pendingSelectedTabUri) {
          setSelectedTabUri(pendingSelectedTabUri)
        }
        return
      } else {
        pendingSelectedTabUriRef.current = null
      }
    }
    if (currentDocUri && currentDocIsOpen) {
      setSelectedTabUri(currentDocUri)
      return
    }
    if (selectedTabUri && !selectedTabIsOpen) {
      setSelectedTabUri(null)
    }
    if (currentDocUri && !currentDocIsOpen) {
      setCurrentDoc(workspaceDocuments[0]?.uri ?? null)
    }
  }, [
    currentDocIsOpen,
    currentDocUri,
    selectedTabIsOpen,
    selectedTabUri,
    setCurrentDoc,
    statusTabVisible,
    workspaceDocumentUris,
    workspaceDocuments,
  ])

  useEffect(() => {
    if (statusTabVisible) {
      showDocument(DRIVE_LINK_STATUS_TAB_URI, {
        title: 'Drive Link Status',
      })
      if (!currentDocUri || !currentDocIsOpen) {
        setCurrentDoc(DRIVE_LINK_STATUS_TAB_URI)
      }
      return
    }

    if (
      workspaceDocuments.some((doc) => doc.uri === DRIVE_LINK_STATUS_TAB_URI)
    ) {
      closeWorkspaceDocument(DRIVE_LINK_STATUS_TAB_URI)
    }
  }, [
    closeWorkspaceDocument,
    currentDocIsOpen,
    currentDocUri,
    setCurrentDoc,
    showDocument,
    statusTabVisible,
    workspaceDocuments,
  ])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const syncWindowFocus = () => {
      setIsWindowFocused(
        document.visibilityState === 'visible' && document.hasFocus()
      )
    }

    syncWindowFocus()
    window.addEventListener('focus', syncWindowFocus)
    window.addEventListener('blur', syncWindowFocus)
    document.addEventListener('visibilitychange', syncWindowFocus)
    return () => {
      window.removeEventListener('focus', syncWindowFocus)
      window.removeEventListener('blur', syncWindowFocus)
      document.removeEventListener('visibilitychange', syncWindowFocus)
    }
  }, [])

  // Keep the active tab discoverable when the tab rail overflows horizontally.
  // We track each rendered tab node and ask the browser to reveal the selected
  // one so keyboard/mouse tab changes do not leave the active notebook clipped.
  useLayoutEffect(() => {
    if (!resolvedSelectedTabUri) {
      return
    }
    const node = tabTriggerRefs.current.get(resolvedSelectedTabUri)
    node?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [resolvedSelectedTabUri])

  // TODO(jlewi): Does it still make sense to have a registration pattern for renderers? What does that buy us over
  // just hardcoding an "if" statement when rendering the outputs. Is that a legacy of the vscode extension where
  // renderers could be registered via extensions for different mimetypes?
  // Register renderers for code cells
  useEffect(() => {
    registerRenderer(MimeType.StatefulRunmeTerminal, {
      onCellUpdate: () => {},
      component: ({
        cell,
        cellData,
        onPid,
        onExitCode,
      }: {
        cell: parser_pb.Cell
        cellData: CellData
        onPid: (pid: number | null) => void
        onExitCode: (exitCode: number | null) => void
      }) => {
        return (
          // TODO(jlewi): Why do we pass cell which is parser_pb.Cell? Rather than CellData?
          <CellConsole
            key={`console-${cell.refId}`}
            cellData={cellData}
            onPid={onPid}
            onExitCode={onExitCode}
          />
        )
      },
    })

    return () => {
      unregisterRenderer(MimeType.StatefulRunmeTerminal)
    }
  }, [registerRenderer, unregisterRenderer])

  const handleCloseTab = useCallback(
    (uri: string) => {
      closeWorkspaceDocument(uri)
    },
    [closeWorkspaceDocument]
  )

  useEffect(() => {
    if (!tabContextMenu) {
      return
    }
    const handleClick = () => setTabContextMenu(null)
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTabContextMenu(null)
      }
    }
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [tabContextMenu])

  const adjustedTabContextMenu = useMemo(() => {
    if (!tabContextMenu) {
      return null
    }
    if (typeof window === 'undefined') {
      return tabContextMenu
    }
    const itemCount =
      4 +
      (tabContextMenu.googleDriveUri ? 1 : 0) +
      (tabContextMenu.ownerSessionId ? 1 : 0) +
      (tabContextMenu.canOpenUpstreamDiff ? 1 : 0)
    const menuWidth = 220
    const menuHeight = itemCount * 36 + 8
    return {
      ...tabContextMenu,
      x: Math.max(0, Math.min(tabContextMenu.x, window.innerWidth - menuWidth)),
      y: Math.max(
        0,
        Math.min(tabContextMenu.y, window.innerHeight - menuHeight)
      ),
    }
  }, [tabContextMenu])

  const handleTabContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, docUri: string) => {
      event.preventDefault()
      event.stopPropagation()
      const document = workspaceDocuments.find((doc) => doc.uri === docUri)
      const requestedUri = document?.requestedUri
      const requestedDriveUri = isGoogleDriveFileUri(requestedUri)
        ? requestedUri
        : null
      const title =
        document?.title?.trim() ||
        getNotebookDisplayName(docUri, document?.title ?? docUri)
      setTabContextMenu({
        x: event.clientX,
        y: event.clientY,
        docUri,
        title,
        shareableUri: docUri,
        googleDriveUri: isGoogleDriveFileUri(docUri)
          ? docUri
          : requestedDriveUri,
        ownerSessionId: getNotebookOwnerSessionId(document?.owner),
        canOpenUpstreamDiff:
          docUri.startsWith('local://') && Boolean(requestedDriveUri),
        readOnly: document?.readOnly,
      })

      if (!store || !docUri.startsWith('local://')) {
        return
      }

      void (async () => {
        try {
          const metadata = await store.getMetadata(docUri)
          const remoteUri = metadata?.remoteUri?.trim() || null
          setTabContextMenu((current) => {
            if (!current || current.docUri !== docUri) {
              return current
            }
            return {
              ...current,
              shareableUri: remoteUri ?? docUri,
              googleDriveUri: isGoogleDriveFileUri(remoteUri)
                ? remoteUri
                : current.googleDriveUri,
              canOpenUpstreamDiff:
                docUri.startsWith('local://') &&
                isGoogleDriveFileUri(remoteUri),
            }
          })
        } catch (error) {
          appLogger.error('Failed to resolve tab metadata for context menu', {
            attrs: {
              scope: 'storage.metadata',
              code: 'TAB_CONTEXT_METADATA_LOOKUP_FAILED',
              docUri,
              error: String(error),
            },
          })
        }
      })()
    },
    [store, workspaceDocuments]
  )

  const handleRenameTab = useCallback(async () => {
    if (!tabContextMenu) {
      return
    }
    if (tabContextMenu.readOnly) {
      setTabContextMenu(null)
      return
    }
    if (!store) {
      setTabContextMenu(null)
      return
    }

    const nextName = window.prompt('Rename notebook', tabContextMenu.title)
    if (nextName === null) {
      setTabContextMenu(null)
      return
    }

    const trimmed = nextName.trim()
    const renamedName = trimmed === '' ? 'untitled.json' : trimmed
    try {
      const renamed = await store.rename(tabContextMenu.docUri, renamedName)
      const title = renamed.name || renamedName
      getNotebookData(tabContextMenu.docUri)?.setName(title)
      showDocument(tabContextMenu.docUri, { title })
      setTabContextMenu(null)
    } catch (error) {
      appLogger.error('Failed to rename notebook from tab context menu', {
        attrs: {
          scope: 'storage.rename',
          code: 'TAB_RENAME_FAILED',
          uri: tabContextMenu.docUri,
          error: String(error),
        },
      })
      showToast({
        message: 'Unable to rename document. Please try again.',
        tone: 'error',
      })
      setTabContextMenu(null)
    }
  }, [getNotebookData, showDocument, store, tabContextMenu])

  const handleCopyTabShareableLink = useCallback(async () => {
    if (!tabContextMenu) {
      return
    }
    try {
      await copyNotebookShareUrl(tabContextMenu.shareableUri)
    } catch (error) {
      appLogger.error('Failed to copy shareable link from tab context menu', {
        attrs: {
          scope: 'storage.share',
          code: 'TAB_COPY_SHAREABLE_LINK_FAILED',
          uri: tabContextMenu.shareableUri,
          error: String(error),
        },
      })
    } finally {
      setTabContextMenu(null)
    }
  }, [tabContextMenu])

  const handleCopyTabMarkdownLink = useCallback(async () => {
    if (!tabContextMenu) {
      return
    }
    try {
      await copyNotebookMarkdownLink(
        tabContextMenu.title,
        tabContextMenu.shareableUri
      )
    } catch (error) {
      appLogger.error('Failed to copy markdown link from tab context menu', {
        attrs: {
          scope: 'storage.share',
          code: 'TAB_COPY_MARKDOWN_LINK_FAILED',
          uri: tabContextMenu.shareableUri,
          error: String(error),
        },
      })
    } finally {
      setTabContextMenu(null)
    }
  }, [tabContextMenu])

  const handleCopyTabLocalUri = useCallback(async () => {
    if (!tabContextMenu) {
      return
    }
    try {
      if (
        typeof window === 'undefined' ||
        !window.navigator?.clipboard?.writeText
      ) {
        throw new Error('Clipboard access is unavailable in this browser')
      }
      await window.navigator.clipboard.writeText(tabContextMenu.docUri)
    } catch (error) {
      appLogger.error('Failed to copy local URI from tab context menu', {
        attrs: {
          scope: 'storage.local',
          code: 'TAB_COPY_LOCAL_URI_FAILED',
          uri: tabContextMenu.docUri,
          error: String(error),
        },
      })
    } finally {
      setTabContextMenu(null)
    }
  }, [tabContextMenu])

  const handleCopyTabOwnerSessionId = useCallback(async () => {
    if (!tabContextMenu?.ownerSessionId) {
      setTabContextMenu(null)
      return
    }
    try {
      if (
        typeof window === 'undefined' ||
        !window.navigator?.clipboard?.writeText
      ) {
        throw new Error('Clipboard access is unavailable in this browser')
      }
      await window.navigator.clipboard.writeText(tabContextMenu.ownerSessionId)
    } catch (error) {
      appLogger.error('Failed to copy owner session ID from tab context menu', {
        attrs: {
          scope: 'tab.owner-session',
          code: 'TAB_COPY_OWNER_SESSION_ID_FAILED',
          uri: tabContextMenu.docUri,
          ownerSessionId: tabContextMenu.ownerSessionId,
          error: String(error),
        },
      })
    } finally {
      setTabContextMenu(null)
    }
  }, [tabContextMenu])

  const handleCopyTabGoogleDriveLink = useCallback(async () => {
    if (!tabContextMenu?.googleDriveUri) {
      setTabContextMenu(null)
      return
    }
    try {
      if (
        typeof window === 'undefined' ||
        !window.navigator?.clipboard?.writeText
      ) {
        throw new Error('Clipboard access is unavailable in this browser')
      }
      await window.navigator.clipboard.writeText(tabContextMenu.googleDriveUri)
    } catch (error) {
      appLogger.error(
        'Failed to copy Google Drive link from tab context menu',
        {
          attrs: {
            scope: 'storage.drive',
            code: 'TAB_COPY_GOOGLE_DRIVE_LINK_FAILED',
            uri: tabContextMenu.googleDriveUri,
            error: String(error),
          },
        }
      )
    } finally {
      setTabContextMenu(null)
    }
  }, [tabContextMenu])

  const handleOpenTabUpstreamDiff = useCallback(async () => {
    if (!tabContextMenu?.canOpenUpstreamDiff) {
      setTabContextMenu(null)
      return
    }
    if (!store) {
      setTabContextMenu(null)
      return
    }
    try {
      await openNotebookUpstreamDiff(store, tabContextMenu.docUri)
    } catch (error) {
      appLogger.error('Failed to open upstream diff from tab context menu', {
        attrs: {
          scope: 'notebook.diff',
          code: 'TAB_OPEN_UPSTREAM_DIFF_FAILED',
          uri: tabContextMenu.docUri,
          error: String(error),
        },
      })
      showToast({
        message: 'Unable to open upstream diff. Please try again.',
        tone: 'error',
      })
    } finally {
      setTabContextMenu(null)
    }
  }, [store, tabContextMenu])

  // Each document gets its own scroll container keyed by URI so the browser
  // does not reuse the previous document's scroll position.

  return (
    <div id="documents" className="flex flex-col h-full">
      {workspaceDocuments.length === 0 ? (
        <ScrollArea
          type="auto"
          scrollbars="vertical"
          className="flex-1 p-4"
          data-testid="actions-empty-scroll"
        >
          <div
            id="actions-empty-state"
            className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-6 text-center text-sm text-nb-text-muted"
          >
            <div id="actions-empty-header" className="space-y-2">
              <Text size="5" weight="bold" as="p" className="text-nb-text">
                No open notebooks yet
              </Text>
              <Text size="2" as="p" className="text-nb-text-muted">
                Use the button below to reveal console commands for mounting
                folders or attaching files programmatically.
              </Text>
            </div>

            <div
              id="actions-empty-hints"
              className="flex flex-col items-center"
            >
              <Button
                id="actions-empty-hints-toggle"
                variant="soft"
                onClick={() => setShowConsoleHints((prev) => !prev)}
              >
                {showConsoleHints
                  ? 'Hide Console Commands'
                  : 'Show Console Commands'}
              </Button>
            </div>

            {showConsoleHints && (
              <div
                id="actions-empty-quickstart"
                className="w-full rounded-lg border border-nb-border bg-nb-surface-2 p-4 text-left"
              >
                <Text size="3" weight="bold" as="p" className="text-nb-text">
                  Quick Start Console Commands
                </Text>
                <Text size="2" as="p" className="mt-1 text-nb-text-muted">
                  These commands are available in the app console and map to the
                  Explorer helpers. The File System Access API requires a picker
                  gesture, so addFolder/openPicker always prompt for a folder.
                </Text>
                {/* Console snippets mirror AppConsole helpers so users can copy/paste. */}
                <pre
                  id="actions-empty-quickstart-code"
                  className="quickstart-console-code mt-3 whitespace-pre-wrap rounded-md bg-gray-900 p-3 text-xs text-gray-100 select-text cursor-text"
                  style={{
                    userSelect: 'text',
                    WebkitUserSelect: 'text',
                  }}
                >
                  explorer.addFolder(){'\n'}
                  explorer.mountDrive(driveUrl){'\n'}
                  explorer.openPicker(){'\n'}
                  explorer.editName(uri){'\n'}
                  explorer.renameFolder(uri, name){'\n'}
                  explorer.listFolders(){'\n'}
                  runme.getCurrentNotebook(){'\n'}
                  runme.clear(){'\n'}
                  runme.runAll(){'\n'}
                  runme.rerun(){'\n'}
                  help(){'\n\n'}
                  To attach test notebooks: use the Explorer + button to pick
                  the fixtures folder
                  {'\n'}
                  To mount a local file: use the Explorer + button or
                  explorer.openPicker()
                </pre>
              </div>
            )}
          </div>
        </ScrollArea>
      ) : (
        <Tabs.Root
          value={resolvedSelectedTabUri}
          onValueChange={(nextUri) => {
            pendingSelectedTabUriRef.current = nextUri
            setSelectedTabUri(nextUri)
            if (nextUri !== currentDocUri) {
              setCurrentDoc(nextUri)
            }
          }}
          className="flex flex-col flex-1 min-h-0 overflow-hidden bg-white"
        >
          <div
            id="notebook-tabs-scroll"
            className="notebook-tab-strip overflow-x-auto overflow-y-hidden border-b border-nb-border bg-nb-surface-2"
          >
            <Tabs.List
              id="notebook-tabs-list"
              className="flex min-w-max items-center gap-0.5 px-2 py-1"
            >
              {workspaceDocuments.map((doc) => {
                const displayName = getNotebookDisplayName(doc.uri, doc.title)
                const isNotebook = isNotebookDocumentUri(doc.uri)
                return (
                  <div
                    key={`tab-${doc.uri}`}
                    ref={(node) => {
                      if (node) {
                        tabTriggerRefs.current.set(doc.uri, node)
                      } else {
                        tabTriggerRefs.current.delete(doc.uri)
                      }
                    }}
                    className="flex shrink-0 items-center gap-1"
                  >
                    <Tabs.Trigger
                      value={doc.uri}
                      title={doc.title}
                      onContextMenu={
                        isNotebook
                          ? (event) => handleTabContextMenu(event, doc.uri)
                          : undefined
                      }
                      className="group flex shrink-0 items-center gap-2 rounded-nb-sm border border-transparent px-3 py-1.5 text-sm font-medium text-nb-text-muted transition-all duration-150 data-[state=active]:border-nb-border data-[state=active]:bg-nb-surface data-[state=active]:text-nb-text data-[state=active]:shadow-nb-xs data-[state=inactive]:hover:bg-nb-surface/60 data-[state=inactive]:hover:text-nb-text focus:outline-none"
                    >
                      <span className="max-w-[140px] truncate">
                        {displayName}
                      </span>
                      {doc.readOnly && <ReadOnlyTabIndicator />}
                    </Tabs.Trigger>
                    {isNotebook && <NotebookSyncIndicator docUri={doc.uri} />}
                    <button
                      type="button"
                      className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-nb-xs text-nb-text-faint transition-all duration-150 hover:bg-nb-surface-2 hover:text-nb-text"
                      aria-label={`Close ${displayName}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        handleCloseTab(doc.uri)
                      }}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <XMarkIcon className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
            </Tabs.List>
          </div>
          {adjustedTabContextMenu && (
            <div
              className="ctx-menu"
              style={{
                top: adjustedTabContextMenu.y,
                left: adjustedTabContextMenu.x,
              }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="ctx-menu-item"
                disabled={adjustedTabContextMenu.readOnly}
                onClick={(event) => {
                  event.stopPropagation()
                  void handleRenameTab()
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCopyTabShareableLink()
                }}
              >
                Copy Shareable Link
              </button>
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCopyTabMarkdownLink()
                }}
              >
                Copy Markdown Link
              </button>
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCopyTabLocalUri()
                }}
              >
                Copy local URI
              </button>
              {adjustedTabContextMenu.ownerSessionId && (
                <button
                  type="button"
                  className="ctx-menu-item"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleCopyTabOwnerSessionId()
                  }}
                >
                  Copy Owner Session ID
                </button>
              )}
              {adjustedTabContextMenu.googleDriveUri && (
                <button
                  type="button"
                  className="ctx-menu-item"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleCopyTabGoogleDriveLink()
                  }}
                >
                  Copy Google Drive Link
                </button>
              )}
              {adjustedTabContextMenu.canOpenUpstreamDiff && (
                <button
                  type="button"
                  className="ctx-menu-item"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleOpenTabUpstreamDiff()
                  }}
                >
                  Compare with upstream
                </button>
              )}
            </div>
          )}
          <div className="relative flex-1 min-h-0 overflow-hidden">
            {workspaceDocuments.map((doc) => (
              <Tabs.Content
                key={`content-${doc.uri}`}
                value={doc.uri}
                forceMount
                asChild
              >
                <TabPanel className="flex-1 min-h-0" data-document-id={doc.uri}>
                  {renderWorkspaceDocument({
                    document: doc,
                    activeCell: activeCellsByDoc[doc.uri] ?? null,
                    deepLinkCellId:
                      deepLinkTargetDocUri === doc.uri ? deepLinkCellId : null,
                    isSelected: resolvedSelectedTabUri === doc.uri,
                    isWindowFocused:
                      isWindowFocused && resolvedSelectedTabUri === doc.uri,
                    onCellFocus: handleCellFocus,
                    onDriveLogin: () =>
                      driveLinkCoordinator.loginToDriveAndProcess(),
                    onDriveRetry: () =>
                      driveLinkCoordinator.retryAuthAndProcess(),
                  })}
                </TabPanel>
              </Tabs.Content>
            ))}
          </div>
        </Tabs.Root>
      )}
    </div>
  )
}
