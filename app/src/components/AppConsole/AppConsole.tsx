import { create } from '@bufbuild/protobuf'
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/20/solid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useFilesystemStore } from '../../contexts/FilesystemStoreContext'
import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import { useNotebookContext } from '../../contexts/NotebookContext'
import { useNotebookStore } from '../../contexts/NotebookStoreContext'
import { useRunners } from '../../contexts/RunnersContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { appState } from '../../lib/runtime/AppState'
import { getAppConsoleData } from '../../lib/appConsole/appConsoleController'
import { useAppConsoleSnapshot } from '../../lib/appConsole/useAppConsoleSnapshot'
import { createAppJsGlobals } from '../../lib/runtime/appJsGlobals'
import { JSKernel } from '../../lib/runtime/jsKernel'
import {
  createRunmeConsoleApi,
  type NotebookDataLike,
} from '../../lib/runtime/runmeConsole'
import { isNotebookDocumentUri } from '../../lib/workspaceDocuments/workspaceDocumentTypes'
import { Runner } from '../../lib/runner'
import {
  FilesystemNotebookStore,
  isFileSystemAccessSupported,
} from '../../storage/fs'
import { parser_pb } from '../../runme/client'
import { ActionOutputItems } from '../Actions/ActionOutputItems'
import Editor from '../Actions/Editor'
import { type ConsoleCell, getHistorySources } from './model'

const STORAGE_KEY = 'runme.appConsoleCollapsed'
const LEGACY_STORAGE_KEY = 'aisre.appConsoleCollapsed'
const textDecoder = new TextDecoder()

type OutputKind = 'stdout' | 'stderr' | 'result'

function buildOutputGroups(outputs: parser_pb.CellOutput[]): Array<{
  key: string
  kind: OutputKind
  outputs: parser_pb.CellOutput[]
}> {
  const groups: Array<{
    key: string
    kind: OutputKind
    outputs: parser_pb.CellOutput[]
  }> = []

  outputs.forEach((output, outputIndex) => {
    ;(output.items ?? []).forEach((item, itemIndex) => {
      if (!item) {
        return
      }

      const mime = item.mime || ''
      const decoded = textDecoder.decode(item.data ?? new Uint8Array())
      if (
        (mime === 'application/vnd.code.notebook.stdout' ||
          mime === 'application/vnd.code.notebook.stderr') &&
        decoded.length === 0
      ) {
        return
      }

      let kind: OutputKind = 'result'
      if (mime === 'application/vnd.code.notebook.stdout') {
        kind = 'stdout'
      } else if (mime === 'application/vnd.code.notebook.stderr') {
        kind = 'stderr'
      }

      groups.push({
        key: `${outputIndex}-${itemIndex}-${kind}`,
        kind,
        outputs: [
          create(parser_pb.CellOutputSchema, {
            items: [item],
          }),
        ],
      })
    })
  })

  return groups
}

function StatusPill({ status }: { status: ConsoleCell['status'] }) {
  const className =
    status === 'success'
      ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30'
      : status === 'error'
        ? 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/30'
        : status === 'running'
          ? 'bg-amber-500/15 text-amber-100 ring-1 ring-amber-300/30'
          : 'bg-sky-500/15 text-sky-100 ring-1 ring-sky-300/30'

  return (
    <span
      data-testid="app-console-cell-status"
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${className}`}
    >
      {status}
    </span>
  )
}

function OutputGroups({ outputs }: { outputs: parser_pb.CellOutput[] }) {
  const groups = useMemo(() => buildOutputGroups(outputs), [outputs])
  if (groups.length === 0) {
    return null
  }

  return (
    <div data-testid="app-console-cell-outputs" className="space-y-2">
      {groups.map((group) => (
        <div
          key={group.key}
          data-testid="app-console-cell-output"
          data-output-kind={group.kind}
          className="rounded-nb-sm border border-white/10 bg-black/15 p-3"
        >
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-400">
            {group.kind}
          </div>
          <ActionOutputItems outputs={group.outputs} />
        </div>
      ))}
    </div>
  )
}

export default function AppConsole({
  showHeader = true,
}: {
  showHeader?: boolean
}) {
  const appConsoleData = getAppConsoleData()
  const { cells, hydrated, loadError } = useAppConsoleSnapshot()
  const { ensureAccessToken } = useGoogleAuth()
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false
    }
    try {
      const stored =
        localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY)
      return stored === 'true'
    } catch (error) {
      console.error('Failed to read console collapse state', error)
      return false
    }
  })

  const draftEditorRef = useRef<any>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [historyBrowseState, setHistoryBrowseState] = useState<{
    index: number | null
    draftBuffer: string
  }>({
    index: null,
    draftBuffer: '',
  })
  const historyBrowseStateRef = useRef(historyBrowseState)
  const pendingFocusCellIdRef = useRef<string | null>(null)

  const updateHistoryBrowseState = useCallback(
    (nextState: { index: number | null; draftBuffer: string }) => {
      historyBrowseStateRef.current = nextState
      setHistoryBrowseState(nextState)
    },
    []
  )

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false')
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch (error) {
      console.error('Failed to persist console collapse state', error)
    }
  }, [collapsed])

  const { updateRunner, deleteRunner, setDefaultRunner } = useRunners()
  const { getItems, addItem, removeItem } = useWorkspace()
  const { getCurrentDoc, getLastNotebookDoc, setCurrentDoc } = useCurrentDoc()
  const { getNotebookData, openNotebook, useNotebookList } =
    useNotebookContext()
  const { showDocument } = useWorkspaceDocumentContext()
  const openNotebooks = useNotebookList()
  const { fsStore, setFsStore } = useFilesystemStore()
  const { store: notebookStore } = useNotebookStore()

  const resolveNotebookStore = useCallback(() => {
    return notebookStore ?? appState.localNotebooks
  }, [notebookStore])

  const ensureFilesystemStore = useCallback(() => {
    if (fsStore) {
      return fsStore
    }
    if (!isFileSystemAccessSupported()) {
      return null
    }
    const store = new FilesystemNotebookStore()
    appState.setFilesystemStore(store)
    setFsStore(store)
    return store
  }, [fsStore, setFsStore])

  const getVisibleNotebookUri = useCallback((): string | null => {
    const activePanel = document.querySelector<HTMLElement>(
      '[data-document-id][data-state="active"]'
    )
    const uri = activePanel?.dataset.documentId
    if (!uri || uri.trim() === '') {
      return null
    }
    return uri
  }, [])

  const resolveNotebookData = useCallback(
    (target?: unknown): NotebookDataLike | null => {
      if (target && typeof target === 'object') {
        const candidate = target as Partial<NotebookDataLike>
        if (
          typeof candidate.getUri === 'function' &&
          typeof candidate.getName === 'function' &&
          typeof candidate.getNotebook === 'function' &&
          typeof candidate.updateCell === 'function' &&
          typeof candidate.getCell === 'function'
        ) {
          return candidate as NotebookDataLike
        }
      }

      if (typeof target === 'string' && target.trim() !== '') {
        const targetUri = target.trim()
        if (!isNotebookDocumentUri(targetUri)) {
          return null
        }
        return getNotebookData(targetUri) ?? null
      }

      const currentUri = getCurrentDoc()
      if (isNotebookDocumentUri(currentUri)) {
        const currentNotebook = getNotebookData(currentUri)
        if (currentNotebook) {
          return currentNotebook
        }
      }

      const fallbackUris = [
        getVisibleNotebookUri(),
        getLastNotebookDoc(),
        openNotebooks[0]?.uri,
      ]
      for (const fallbackUri of fallbackUris) {
        if (!isNotebookDocumentUri(fallbackUri)) {
          continue
        }
        const notebook = getNotebookData(fallbackUri)
        if (notebook) {
          return notebook
        }
      }
      return null
    },
    [
      getCurrentDoc,
      getLastNotebookDoc,
      getNotebookData,
      getVisibleNotebookUri,
      openNotebooks,
    ]
  )

  const runme = useMemo(
    () =>
      createRunmeConsoleApi({
        resolveNotebook: resolveNotebookData,
      }),
    [resolveNotebookData]
  )

  const currentCell = cells[cells.length - 1] ?? null
  const historySources = useMemo(() => getHistorySources(cells), [cells])
  const historyIndex = historyBrowseState.index
  const canBrowsePrevious =
    currentCell?.status === 'draft' &&
    historySources.length > 0 &&
    (historyIndex === null || historyIndex < historySources.length - 1)
  const canBrowseNext = currentCell?.status === 'draft' && historyIndex !== null

  useEffect(() => {
    if (!currentCell || currentCell.status !== 'draft') {
      return
    }
    if (pendingFocusCellIdRef.current !== currentCell.id) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      draftEditorRef.current?.focus?.()
      pendingFocusCellIdRef.current = null
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [currentCell])

  useEffect(() => {
    const body = bodyRef.current
    if (!body || typeof body.scrollTo !== 'function') {
      return
    }
    body.scrollTo({
      top: body.scrollHeight,
      behavior: 'smooth',
    })
  }, [cells])

  const setCurrentSource = useCallback(
    (source: string, clearHistoryBrowse = true) => {
      appConsoleData.setDraftSource(source)

      if (clearHistoryBrowse) {
        updateHistoryBrowseState({
          index: null,
          draftBuffer: '',
        })
      }
    },
    [appConsoleData, updateHistoryBrowseState]
  )

  const browseHistory = useCallback(
    (direction: 'previous' | 'next') => {
      const draft = appConsoleData.getSnapshot().cells.at(-1)
      if (!draft || draft.status !== 'draft') {
        return
      }

      const history = getHistorySources(appConsoleData.getSnapshot().cells)

      if (history.length === 0) {
        return
      }

      const state = historyBrowseStateRef.current
      if (direction === 'previous') {
        const nextIndex =
          state.index === null
            ? 0
            : Math.min(state.index + 1, history.length - 1)
        const draftBuffer =
          state.index === null ? draft.source : state.draftBuffer
        const nextSource =
          history[history.length - 1 - nextIndex] ?? draft.source
        updateHistoryBrowseState({
          index: nextIndex,
          draftBuffer,
        })
        if (nextSource === draft.source) {
          return
        }
        appConsoleData.setDraftSource(nextSource)
        return
      }

      if (state.index === null) {
        return
      }

      const nextIndex = state.index - 1
      const nextSource =
        nextIndex >= 0
          ? (history[history.length - 1 - nextIndex] ?? draft.source)
          : state.draftBuffer

      updateHistoryBrowseState(
        nextIndex >= 0
          ? {
              index: nextIndex,
              draftBuffer: state.draftBuffer,
            }
          : {
              index: null,
              draftBuffer: '',
            }
      )

      if (nextSource === draft.source) {
        return
      }

      appConsoleData.setDraftSource(nextSource)
    },
    [appConsoleData, updateHistoryBrowseState]
  )

  const executeCurrentCell = useCallback(async () => {
    await appConsoleData.hydrate()

    const execution = appConsoleData.startDraftExecution()
    if (!execution) {
      return
    }

    updateHistoryBrowseState({
      index: null,
      draftBuffer: '',
    })

    const globals = createAppJsGlobals({
      runme,
      sendOutput: (data) => appConsoleData.appendStdout(execution.cellId, data),
      resolveNotebookStore,
      ensureFilesystemStore,
      workspace: {
        getItems,
        addItem,
        removeItem,
      },
      openNotebook: async (uri) => {
        const result = await openNotebook(uri)
        showDocument(result.localUri, {
          title: result.entry.name,
        })
        setCurrentDoc(result.localUri)
      },
      resolveNotebook: resolveNotebookData,
      listNotebooks: () =>
        openNotebooks.reduce<NotebookDataLike[]>((items, notebook) => {
          const resolved = getNotebookData(notebook.uri)
          if (resolved) {
            items.push(resolved)
          }
          return items
        }, []),
      ensureAccessToken,
      runnerSync: {
        onUpdated: (runner) => {
          updateRunner(
            new Runner({
              name: runner.name,
              endpoint: runner.endpoint,
              reconnect: runner.reconnect,
              interceptors: [],
            })
          )
        },
        onDeleted: deleteRunner,
        onDefaultSet: setDefaultRunner,
      },
    })

    const kernel = new JSKernel({
      globals,
      hooks: {
        onStdout: (data) => appConsoleData.appendStdout(execution.cellId, data),
        onStderr: (data) => appConsoleData.appendStderr(execution.cellId, data),
      },
    })

    try {
      const { exitCode, result } = await kernel.run(execution.source)
      appConsoleData.completeExecution(execution.cellId, {
        exitCode,
        result,
      })
      const nextDraft = appConsoleData.getSnapshot().cells.at(-1)
      pendingFocusCellIdRef.current =
        nextDraft?.status === 'draft' ? nextDraft.id : null
    } catch (error) {
      appConsoleData.failExecution(execution.cellId, {
        message: String(error),
      })
      const nextDraft = appConsoleData.getSnapshot().cells.at(-1)
      pendingFocusCellIdRef.current =
        nextDraft?.status === 'draft' ? nextDraft.id : null
    }
  }, [
    addItem,
    appConsoleData,
    deleteRunner,
    ensureFilesystemStore,
    getItems,
    getNotebookData,
    openNotebook,
    openNotebooks,
    removeItem,
    resolveNotebookData,
    resolveNotebookStore,
    runme,
    setCurrentDoc,
    showDocument,
    setDefaultRunner,
    updateHistoryBrowseState,
    updateRunner,
  ])

  const registerDraftEditor = useCallback(
    (editor: any, monaco: any) => {
      draftEditorRef.current = editor
      if (!monaco?.KeyMod || !monaco?.KeyCode) {
        return
      }

      editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
        void executeCurrentCell()
      })
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyP, () => {
        browseHistory('previous')
      })
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyN, () => {
        browseHistory('next')
      })
    },
    [browseHistory, executeCurrentCell]
  )

  const isBodyHidden = showHeader && collapsed

  return (
    <div
      id="app-console"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-nb-md border border-nb-cell-border bg-[#0f1014] text-white shadow-nb-sm"
    >
      {showHeader && (
        <div
          id="app-console-header"
          className="flex items-center justify-between border-b border-nb-tray-border bg-[#1a1a2e] px-3"
        >
          <span className="text-[12.6px] font-mono font-medium">
            App Console
          </span>
          <button
            type="button"
            aria-label={
              collapsed ? 'Expand app console' : 'Collapse app console'
            }
            className="inline-flex h-8 w-8 items-center justify-center rounded bg-black/0 text-[12.6px] font-mono font-medium text-white hover:bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/80"
            style={{ backgroundColor: 'transparent' }}
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? (
              <ChevronUpIcon className="h-4 w-4" />
            ) : (
              <ChevronDownIcon className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
      <div
        id="app-console-body"
        className={`${isBodyHidden ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col bg-[#0f1014]`}
      >
        <div
          ref={bodyRef}
          data-testid="app-console-cells"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
        >
          {loadError ? (
            <div className="rounded-nb-sm border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {loadError}
            </div>
          ) : null}
          {cells.map((cell) => {
            const isCurrent = currentCell?.id === cell.id
            const isEditable = isCurrent && cell.status === 'draft'
            const isFrozen =
              cell.status === 'success' || cell.status === 'error'

            return (
              <article
                key={cell.id}
                data-testid="app-console-cell"
                data-console-cell-id={cell.id}
                data-console-cell-index={`${cell.index}`}
                data-status={cell.status}
                data-current={isCurrent ? 'true' : 'false'}
                className={`rounded-nb-md border p-3 shadow-sm ${
                  isCurrent
                    ? 'border-sky-400/40 bg-[#151a27]'
                    : 'border-white/10 bg-[#12151e]'
                }`}
              >
                <div
                  data-testid="app-console-cell-header"
                  className="mb-3 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2">
                    <span
                      data-testid="app-console-cell-index"
                      className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300"
                    >
                      Cell {cell.index}
                    </span>
                    <StatusPill status={cell.status} />
                  </div>
                  <div className="flex items-center gap-2">
                    {isFrozen ? (
                      <button
                        type="button"
                        data-testid="app-console-cell-copy-to-draft"
                        disabled={currentCell?.status !== 'draft'}
                        className="rounded border border-white/15 px-2 py-1 text-[11px] font-medium text-slate-200 transition hover:border-sky-300/50 hover:bg-sky-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => {
                          appConsoleData.copyCellSourceToDraft(cell.id)
                          draftEditorRef.current?.focus?.()
                        }}
                      >
                        Copy to draft
                      </button>
                    ) : null}
                    {isEditable ? (
                      <>
                        <button
                          type="button"
                          data-testid="app-console-history-previous"
                          aria-label="Previous history entry (Alt+P)"
                          title="Previous history entry (Alt+P)"
                          disabled={!canBrowsePrevious}
                          className="rounded border border-white/15 px-2 py-1 text-[11px] font-medium text-slate-200 transition hover:border-sky-300/50 hover:bg-sky-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => {
                            browseHistory('previous')
                            draftEditorRef.current?.focus?.()
                          }}
                        >
                          Prev
                        </button>
                        <button
                          type="button"
                          data-testid="app-console-history-next"
                          aria-label="Next history entry (Alt+N)"
                          title="Next history entry (Alt+N)"
                          disabled={!canBrowseNext}
                          className="rounded border border-white/15 px-2 py-1 text-[11px] font-medium text-slate-200 transition hover:border-sky-300/50 hover:bg-sky-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => {
                            browseHistory('next')
                            draftEditorRef.current?.focus?.()
                          }}
                        >
                          Next
                        </button>
                        <button
                          type="button"
                          data-testid="app-console-cell-run"
                          className="rounded border border-sky-300/40 bg-sky-400/10 px-2 py-1 text-[11px] font-medium text-sky-100 transition hover:bg-sky-400/20"
                          onClick={() => {
                            void executeCurrentCell()
                          }}
                        >
                          Run
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>

                <div
                  data-testid="app-console-cell-input"
                  className="rounded-nb-sm border border-white/10 bg-[#0e1320] p-2"
                >
                  {isEditable || cell.status === 'running' ? (
                    <Editor
                      id={`app-console-cell-${cell.id}`}
                      value={cell.source}
                      language="javascript"
                      ariaLabel={
                        isEditable
                          ? 'App Console input'
                          : `App Console cell ${cell.index} source`
                      }
                      autoFocusWhenEmpty={isEditable}
                      readOnly={!isEditable}
                      onChange={(value) => {
                        if (!isEditable) {
                          return
                        }
                        setCurrentSource(value)
                      }}
                      onEnter={() => {
                        void executeCurrentCell()
                      }}
                      onMount={isEditable ? registerDraftEditor : undefined}
                    />
                  ) : (
                    <pre
                      data-testid="app-console-cell-source"
                      className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#141b2b] px-3 py-3 text-xs leading-relaxed text-slate-100"
                    >
                      {cell.source}
                    </pre>
                  )}
                </div>

                <OutputGroups outputs={cell.outputs} />

                {isCurrent && cell.status === 'draft' ? (
                  <div className="mt-3 text-[11px] text-slate-400">
                    <span className="font-semibold text-slate-300">
                      Shortcuts:
                    </span>{' '}
                    <span>Shift+Enter to run. Alt+P/Alt+N browse history.</span>
                  </div>
                ) : null}
              </article>
            )
          })}
          {!hydrated ? (
            <div className="text-xs text-slate-400">
              Loading console history…
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
