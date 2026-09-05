// @vitest-environment jsdom
import type { ReactElement, ReactNode } from 'react'

import { Theme } from '@radix-ui/themes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  render as renderWithoutTheme,
  screen,
  act,
  createEvent,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import { clone, create } from '@bufbuild/protobuf'
import {
  APPKERNEL_RUNNER_NAME,
  APPKERNEL_SANDBOX_RUNNER_NAME,
} from '../../lib/runtime/appKernel'
import { driveLinkCoordinator } from '../../lib/driveLinkCoordinator'
import { appState } from '../../lib/runtime/AppState'
import { createCellCommentAnchor } from '../../lib/notebookComments'

import { parser_pb, RunmeMetadataKey } from '../../runme/client'
import type { CellData } from '../../lib/notebookData'
import type { NotebookOwnershipRecord } from '../../lib/tabCoordination/notebookOwnership'
import { computeNotebookDiff } from '../../lib/notebookDiff/diff'
import {
  getNotebookDiffDocumentUri,
  registerNotebookDiffDocument,
} from '../../lib/notebookDiff/registry'
import {
  APP_CONSOLE_DOCUMENT_URI,
  getOperationLogSuggestionDocumentUri,
  getRunnerKernelsDocumentUri,
  LOGS_DOCUMENT_URI,
  VERSION_INFO_DOCUMENT_URI,
} from '../../lib/workspaceDocuments/workspaceDocumentTypes'
import { ActionOutputItems } from './ActionOutputItems'
import Actions, { Action } from './Actions'

function ThemeWrapper({ children }: { children: ReactNode }) {
  return <Theme>{children}</Theme>
}

function render(ui: ReactElement) {
  return renderWithoutTheme(ui, { wrapper: ThemeWrapper })
}

const contextMocks = vi.hoisted(() => ({
  workspaceDocuments: [] as Array<{
    uri: string
    title: string
    requestedUri?: string
    state?: 'loading' | 'loaded' | 'blocked' | 'error'
    readOnly?: boolean
    releasePending?: boolean
    writeAccessRequestState?: 'pending' | 'error'
    writeAccessErrorMessage?: string
    refreshErrorMessage?: string
    owner?: NotebookOwnershipRecord | null
  }>,
  openNotebooks: [] as Array<{
    uri: string
    requestedUri: string
    name: string
    state: 'loading' | 'loaded' | 'blocked' | 'error'
    operationLog?: boolean
    refreshErrorMessage?: string
  }>,
  currentDoc: null as string | null,
  setCurrentDoc: vi.fn(),
  showDocument: vi.fn(),
  closeWorkspaceDocument: vi.fn(),
  getNotebookData: vi.fn(),
  openNotebook: vi.fn(),
  requestWriteAccess: vi.fn(async () => undefined),
  refreshReadOnlyNotebook: vi.fn(async () => undefined),
  notebookSnapshots: new Map<
    string,
    {
      uri: string
      loaded: boolean
      readOnly?: boolean
      releasePending?: boolean
      notebook: parser_pb.Notebook
    }
  >(),
  notebookStore: null as null | {
    files?: { get: ReturnType<typeof vi.fn> }
    getMetadata: ReturnType<typeof vi.fn>
    getSyncState: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
    refreshConflictWithLatestUpstream?: ReturnType<typeof vi.fn>
    resolveConflictWithLocal?: ReturnType<typeof vi.fn>
    sync?: ReturnType<typeof vi.fn>
    subscribeSync: ReturnType<typeof vi.fn>
    listOperationLogComments?: ReturnType<typeof vi.fn>
    addOperationLogComment?: ReturnType<typeof vi.fn>
    replyToOperationLogComment?: ReturnType<typeof vi.fn>
    setOperationLogCommentResolved?: ReturnType<typeof vi.fn>
  },
}))

const conflictMocks = vi.hoisted(() => ({
  openNotebookConflictDiff: vi.fn(async () => undefined),
  openNotebookUpstreamDiff: vi.fn(async () => undefined),
  refreshNotebookConflictDiff: vi.fn(async () => undefined),
  restoreDeletedConflictCell: vi.fn(async () => undefined),
}))

const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}))

const imageEmbeddingMocks = vi.hoisted(() => ({
  embedImageInNotebook: vi.fn(async () => ({
    uri: 'local://file/images',
    cell: { refId: 'image-cell' },
  })),
  pickImageFromLocalFilesystem: vi.fn(async (): Promise<File | null> => null),
  isSupportedImageFile: vi.fn(
    (file: File) =>
      file.type.startsWith('image/') ||
      /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(file.name)
  ),
}))

const linkedResourceMocks = vi.hoisted(() => ({
  attachResourceToNotebook: vi.fn(async () => ({
    uri: 'local://file/images.json',
    cell: { refId: 'resource-cell' },
    resource: {
      source: {
        provider: 'google-drive',
        uri: 'https://drive.google.com/file/d/resource-file/view',
      },
    },
  })),
  pickResourceFromLocalFilesystem: vi.fn(
    async (): Promise<File | null> => null
  ),
  pickDriveFile: vi.fn(async () => null),
  pickDriveFolder: vi.fn(async () => ({
    uri: 'https://drive.google.com/drive/folders/assets-folder',
    name: 'Assets',
  })),
}))

const runnerContextMocks = vi.hoisted(() => ({
  runners: [] as Array<{
    name: string
    endpoint: string
    reconnect: boolean
    interceptors: []
  }>,
  defaultRunnerName: '<default>' as string | null,
}))

const commentsPanelMocks = vi.hoisted(() => ({
  commentsPanelOpen: false,
  setCommentsPanelOpen: vi.fn(),
  openCommentsPanel: vi.fn(),
}))

// Minimal mocks for contexts Action consumes
vi.mock('../../contexts/OutputContext', () => ({
  useOutput: () => ({
    getRenderer: () => undefined,
    getAllRenderers: () => {
      throw new Error('Action should not query renderers during local mutation')
    },
    registerRenderer: () => {},
    unregisterRenderer: () => {},
  }),
}))

vi.mock('../../contexts/RunnersContext', () => ({
  useRunners: () => ({
    listRunners: () => runnerContextMocks.runners,
    defaultRunnerName: runnerContextMocks.defaultRunnerName,
  }),
}))

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    createAuthInterceptors: () => [],
    webAppSettings: { runner: '', language: '' },
  }),
}))

vi.mock('../../contexts/NotebookContext', () => ({
  useNotebookContext: () => ({
    getNotebookData: contextMocks.getNotebookData,
    openNotebook: contextMocks.openNotebook,
    requestWriteAccess: contextMocks.requestWriteAccess,
    refreshReadOnlyNotebook: contextMocks.refreshReadOnlyNotebook,
    getOpenNotebooks: () => contextMocks.openNotebooks,
    useNotebookSnapshot: (uri: string) =>
      contextMocks.notebookSnapshots.get(uri) ?? null,
  }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    useWorkspaceDocuments: () => contextMocks.workspaceDocuments,
    showDocument: contextMocks.showDocument,
    closeWorkspaceDocument: contextMocks.closeWorkspaceDocument,
  }),
}))

vi.mock('../../contexts/NotebookStoreContext', () => ({
  useNotebookStore: () => ({
    store: contextMocks.notebookStore,
  }),
}))

vi.mock('../../contexts/FilesystemStoreContext', () => ({
  useFilesystemStore: () => ({
    fsStore: null,
    setFsStore: () => {},
  }),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => contextMocks.currentDoc,
    setCurrentDoc: contextMocks.setCurrentDoc,
  }),
}))

vi.mock('../../contexts/CommentsPanelContext', () => ({
  useCommentsPanel: () => ({
    commentsPanelOpen: commentsPanelMocks.commentsPanelOpen,
    setCommentsPanelOpen: commentsPanelMocks.setCommentsPanelOpen,
    openCommentsPanel: commentsPanelMocks.openCommentsPanel,
  }),
}))

vi.mock('../OperationLogSuggestions/OperationLogSuggestionView', () => ({
  OperationLogSuggestionView: ({
    docUri,
    onClose,
  }: {
    docUri: string
    onClose: () => void
  }) => (
    <div data-testid="suggestion-view" data-notebook-uri={docUri}>
      <button type="button" onClick={onClose}>
        Edit view
      </button>
    </div>
  ),
}))

vi.mock('../../lib/notebookDiff/conflict', () => ({
  openNotebookConflictDiff: conflictMocks.openNotebookConflictDiff,
  openNotebookUpstreamDiff: conflictMocks.openNotebookUpstreamDiff,
  refreshNotebookConflictDiff: conflictMocks.refreshNotebookConflictDiff,
  restoreDeletedConflictCell: conflictMocks.restoreDeletedConflictCell,
}))

vi.mock('../../lib/toast', () => ({
  showToast: toastMocks.showToast,
}))

vi.mock('../../lib/imageEmbedding', () => imageEmbeddingMocks)

vi.mock('../../lib/linkedResourceAttachments', () => ({
  attachResourceToNotebook: linkedResourceMocks.attachResourceToNotebook,
  pickResourceFromLocalFilesystem:
    linkedResourceMocks.pickResourceFromLocalFilesystem,
}))

vi.mock('../Workspace/useDriveResourcePicker', () => ({
  useDriveResourcePicker: () => ({
    pickDriveFile: linkedResourceMocks.pickDriveFile,
    pickDriveFolder: linkedResourceMocks.pickDriveFolder,
  }),
}))

vi.mock('../../lib/runtime/jupyterManager', () => ({
  DEFAULT_JUPYTER_KERNEL_ARGV: [
    'python3',
    '-m',
    'ipykernel_launcher',
    '-f',
    '{connection_file}',
  ],
  getJupyterManager: () => ({
    subscribe: () => () => {},
    getVersion: () => 0,
    ensureRunnerData: async () => {},
    getKernelOptionsForRunner: () => [],
    getKernelsForRunner: () => [],
    listKernels: async () => [],
    startKernel: async () => ({ id: 'kernel-1', name: 'python3' }),
    restartKernel: async () => ({ id: 'kernel-1', name: 'python3' }),
    stopKernel: async () => {},
    getKernelOptionKey: (runnerName: string, kernelId: string) =>
      `${runnerName}:${kernelId}`,
    parseKernelOptionKey: (key: string) => {
      if (!key.includes(':')) return null
      const [runnerName, kernelId] = key.split(':', 2)
      if (!runnerName || !kernelId) return null
      return { runnerName, kernelId }
    },
  }),
}))

vi.mock('../AppConsole/AppConsole', () => ({
  default: ({ showHeader }: { showHeader?: boolean }) => (
    <div
      data-show-header={showHeader ? 'true' : 'false'}
      data-testid="app-console-mock"
    >
      App console mock
    </div>
  ),
}))

vi.mock('../Logs/LogsPane', () => ({
  default: () => <div data-testid="logs-pane-mock">Logs pane mock</div>,
}))

// Mock runmedev/renderers to avoid registering the real web component,
// which depends on adoptedStyleSheets and other browser-only APIs.
vi.mock('@runmedev/renderers', () => ({
  ClientMessages: {
    terminalStdin: 'terminal:stdin',
    terminalStdout: 'terminal:stdout',
  },
  setContext: vi.fn(),
}))

vi.mock('../../contexts/CellContext', () => ({}))

// Minimal stub CellData to drive runID changes.
class StubCellData {
  snapshot: parser_pb.Cell
  private listeners = new Set<() => void>()
  getRunnerName = () => '<default>'
  getJupyterServerName = () => ''
  getJupyterKernelID = () => ''
  getJupyterKernelName = () => ''
  setRunner = vi.fn((name: string) => {
    const next = clone(parser_pb.CellSchema, this.snapshot)
    next.metadata = { ...(next.metadata ?? {}) }
    if (name === '<default>') {
      delete next.metadata[RunmeMetadataKey.RunnerName]
    } else {
      next.metadata[RunmeMetadataKey.RunnerName] = name
    }
    this.update(next)
  })
  setJupyterKernel = () => {}
  clearJupyterKernel = () => {}
  update = vi.fn((nextCell: parser_pb.Cell) => {
    this.snapshot = clone(parser_pb.CellSchema, nextCell)
    this.listeners.forEach((listener) => listener())
  })

  constructor(cell: parser_pb.Cell) {
    this.snapshot = cell
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeToContentChange(listener: () => void) {
    return this.subscribe(listener)
  }

  subscribeToRunIDChange(_listener: (id: string) => void) {
    return () => {}
  }

  getRunID() {
    const runID = this.snapshot.metadata?.[RunmeMetadataKey.LastRunID]
    return typeof runID === 'string' ? runID : ''
  }

  setRunID(id: string) {
    const next = clone(parser_pb.CellSchema, this.snapshot)
    next.metadata = { ...(next.metadata ?? {}) }
    if (id) {
      next.metadata[RunmeMetadataKey.LastRunID] = id
    } else {
      delete next.metadata[RunmeMetadataKey.LastRunID]
    }
    this.update(next)
  }

  getStreams() {
    if (!this.getRunID()) {
      return null
    }
    const sub = () => ({ unsubscribe: () => {} })
    return {
      stdout: { subscribe: sub },
      stderr: { subscribe: sub },
      pid: { subscribe: sub },
      exitCode: { subscribe: sub },
      mimeType: { subscribe: sub },
      errors: { subscribe: sub },
      sendExecuteRequest: () => {},
      setCallback: () => {},
      close: () => {},
      connect: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
    } as any
  }
  addBefore = vi.fn()
  addAfter = vi.fn()
  remove = vi.fn()
  run = vi.fn()
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.history.replaceState(null, '', '/')
  contextMocks.workspaceDocuments = []
  contextMocks.openNotebooks = []
  contextMocks.currentDoc = null
  contextMocks.setCurrentDoc.mockReset()
  contextMocks.setCurrentDoc.mockImplementation((uri: string | null) => {
    contextMocks.currentDoc = uri
  })
  contextMocks.showDocument.mockReset()
  contextMocks.closeWorkspaceDocument.mockReset()
  contextMocks.getNotebookData.mockReset()
  contextMocks.getNotebookData.mockReturnValue(null)
  contextMocks.openNotebook.mockReset()
  contextMocks.openNotebook.mockImplementation(async (uri: string) => ({
    localUri: uri,
    entry: { name: 'Notes.json' },
  }))
  contextMocks.requestWriteAccess.mockReset()
  contextMocks.requestWriteAccess.mockResolvedValue(undefined)
  contextMocks.refreshReadOnlyNotebook.mockReset()
  contextMocks.refreshReadOnlyNotebook.mockResolvedValue(undefined)
  contextMocks.notebookSnapshots.clear()
  contextMocks.notebookStore = null
  commentsPanelMocks.commentsPanelOpen = false
  commentsPanelMocks.setCommentsPanelOpen.mockReset()
  commentsPanelMocks.openCommentsPanel.mockReset()
  appState.setDriveNotebookStore(null)
  appState.setLocalComments(null)
  conflictMocks.openNotebookConflictDiff.mockReset()
  conflictMocks.openNotebookConflictDiff.mockResolvedValue(undefined)
  conflictMocks.openNotebookUpstreamDiff.mockReset()
  conflictMocks.openNotebookUpstreamDiff.mockResolvedValue(undefined)
  conflictMocks.refreshNotebookConflictDiff.mockReset()
  conflictMocks.refreshNotebookConflictDiff.mockResolvedValue(undefined)
  toastMocks.showToast.mockReset()
  imageEmbeddingMocks.embedImageInNotebook.mockClear()
  imageEmbeddingMocks.pickImageFromLocalFilesystem.mockReset()
  imageEmbeddingMocks.pickImageFromLocalFilesystem.mockResolvedValue(null)
  imageEmbeddingMocks.isSupportedImageFile.mockClear()
  linkedResourceMocks.attachResourceToNotebook.mockClear()
  linkedResourceMocks.pickResourceFromLocalFilesystem.mockReset()
  linkedResourceMocks.pickResourceFromLocalFilesystem.mockResolvedValue(null)
  linkedResourceMocks.pickDriveFile.mockReset()
  linkedResourceMocks.pickDriveFile.mockResolvedValue(null)
  linkedResourceMocks.pickDriveFolder.mockReset()
  linkedResourceMocks.pickDriveFolder.mockResolvedValue({
    uri: 'https://drive.google.com/drive/folders/assets-folder',
    name: 'Assets',
  })
  runnerContextMocks.runners = []
  runnerContextMocks.defaultRunnerName = '<default>'
})

describe('Actions tabs', () => {
  it('opens suggestion review as a separate workspace tab', async () => {
    const uri = 'local://file/suggestions'
    const suggestionUri = getOperationLogSuggestionDocumentUri(uri)
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'suggestions.runme', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue({ appendCell: vi.fn() })
    contextMocks.notebookStore = {
      getMetadata: vi.fn(),
      getSyncState: vi.fn(async () => null),
      listOperationLogComments: vi.fn(async () => []),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }

    render(<Actions />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Review suggestions' })
    )

    expect(contextMocks.showDocument).toHaveBeenCalledWith(suggestionUri, {
      title: 'Suggestions · suggestions.runme',
      afterUri: uri,
    })
    expect(contextMocks.setCurrentDoc).toHaveBeenCalledWith(suggestionUri)
  })

  it('keeps the edit and suggestion views mounted in separate tabs', async () => {
    const uri = 'local://file/suggestions'
    const suggestionUri = getOperationLogSuggestionDocumentUri(uri)
    contextMocks.currentDoc = suggestionUri
    contextMocks.openNotebooks = [
      {
        uri,
        requestedUri: uri,
        name: 'suggestions.runme',
        state: 'loaded',
        operationLog: true,
      },
    ]
    contextMocks.workspaceDocuments = [
      { uri, title: 'suggestions.runme', state: 'loaded' },
      {
        uri: suggestionUri,
        title: 'Suggestions · suggestions.runme',
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue({ appendCell: vi.fn() })
    contextMocks.notebookStore = {
      getMetadata: vi.fn(),
      getSyncState: vi.fn(async () => null),
      listOperationLogComments: vi.fn(async () => []),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.closeWorkspaceDocument.mockReturnValue(uri)

    render(<Actions />)

    expect(await screen.findByTestId('notebook-content')).toBeTruthy()
    expect(
      (await screen.findByTestId('suggestion-view')).dataset.notebookUri
    ).toBe(uri)
    expect(screen.getByTitle('suggestions.runme')).toBeTruthy()
    expect(screen.getByTitle('Suggestions · suggestions.runme')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Edit view' }))
    expect(contextMocks.closeWorkspaceDocument).toHaveBeenCalledWith(
      suggestionUri
    )
    expect(contextMocks.setCurrentDoc).toHaveBeenCalledWith(uri)
  })

  it('keeps the complete .runme comment lifecycle in the operation log', async () => {
    const uri = 'local://file/comments.runme'
    const cells = ['cell-open', 'cell-resolved', 'cell-new'].map((refId) =>
      create(parser_pb.CellSchema, {
        refId,
        kind: parser_pb.CellKind.MARKUP,
        languageId: 'markdown',
        value: `Content for ${refId}`,
      })
    )
    const cellData = new Map(
      cells.map((cell) => [cell.refId, new StubCellData(cell)])
    )
    const comments = [
      {
        id: 'comment-open',
        content: 'Open operation-log comment',
        anchor: createCellCommentAnchor('cell-open'),
        resolved: false,
        replies: [],
      },
      {
        id: 'comment-resolved',
        content: 'Resolved operation-log comment',
        anchor: createCellCommentAnchor('cell-resolved'),
        resolved: true,
        replies: [],
      },
    ]
    const store = {
      getMetadata: vi.fn(async () => ({
        remoteUri: 'https://drive.google.com/file/d/drive-copy/view',
      })),
      getSyncState: vi.fn(async () => ({
        status: 'synced',
        localUri: uri,
        remoteId: 'https://drive.google.com/file/d/drive-copy/view',
      })),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => undefined),
      listOperationLogComments: vi.fn(async () => comments),
      addOperationLogComment: vi.fn(async () => comments[0]),
      replyToOperationLogComment: vi.fn(async () => comments[0]),
      setOperationLogCommentResolved: vi.fn(async () => comments[0]),
    }
    const localComments = {
      list: vi.fn(),
      listPendingRecords: vi.fn(),
      saveDesiredComment: vi.fn(),
      saveDesiredReply: vi.fn(),
      setThreadIntent: vi.fn(),
      reconcile: vi.fn(),
    }
    const driveStore = { listComments: vi.fn() }

    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'comments.runme',
        requestedUri:
          'https://drive.google.com/file/d/drive-copy/view?resourcekey=key',
        state: 'loaded',
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { cells }),
    })
    contextMocks.getNotebookData.mockReturnValue({
      getCell: (refId: string) => cellData.get(refId),
      appendCell: vi.fn(),
    })
    contextMocks.notebookStore = store
    commentsPanelMocks.commentsPanelOpen = true
    appState.setLocalComments(localComments as never)
    appState.setDriveNotebookStore(driveStore as never)

    render(<Actions />)

    await waitFor(() => {
      expect(store.listOperationLogComments).toHaveBeenCalledWith(uri)
      expect(screen.getByText('Stored in this .runme notebook')).toBeTruthy()
    })
    expect(screen.queryByText('Google Drive comment threads')).toBeNull()

    const reply = screen.getByPlaceholderText('Reply or add others with @')
    fireEvent.change(reply, { target: { value: 'Operation-log reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => {
      expect(store.replyToOperationLogComment).toHaveBeenCalledWith(
        uri,
        'comment-open',
        'Operation-log reply'
      )
    })

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    await waitFor(() => {
      expect(store.setOperationLogCommentResolved).toHaveBeenCalledWith(
        uri,
        'comment-open',
        true
      )
    })

    fireEvent.click(screen.getByRole('button', { name: /resolved 1/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => {
      expect(store.setOperationLogCommentResolved).toHaveBeenCalledWith(
        uri,
        'comment-resolved',
        false
      )
    })

    const newCell = document.querySelector<HTMLElement>(
      '[data-cell-ref-id="cell-new"]'
    )
    expect(newCell).not.toBeNull()
    fireEvent.click(
      within(newCell as HTMLElement).getByRole('button', {
        name: 'Add comment',
      })
    )
    const draft = await screen.findByText('New comment on Cell 3')
    const draftArticle = draft.closest('article') as HTMLElement
    fireEvent.change(within(draftArticle).getByRole('textbox'), {
      target: { value: 'New operation-log comment' },
    })
    fireEvent.click(
      within(draftArticle).getByRole('button', { name: 'Comment' })
    )
    await waitFor(() => {
      expect(store.addOperationLogComment).toHaveBeenCalledWith(
        uri,
        expect.objectContaining({
          content: 'New operation-log comment',
          anchor: expect.stringContaining('cell-new'),
        })
      )
    })

    expect(localComments.list).not.toHaveBeenCalled()
    expect(localComments.saveDesiredComment).not.toHaveBeenCalled()
    expect(localComments.saveDesiredReply).not.toHaveBeenCalled()
    expect(localComments.setThreadIntent).not.toHaveBeenCalled()
    expect(localComments.reconcile).not.toHaveBeenCalled()
    expect(driveStore.listComments).not.toHaveBeenCalled()
  })

  it('embeds an image selected from the button beside Add cell', async () => {
    const uri = 'local://file/images.json'
    const notebookData = {
      getCell: vi.fn(),
      appendCell: vi.fn(),
    }
    const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
      type: 'image/png',
    })
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'images.json', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue(notebookData)
    imageEmbeddingMocks.pickImageFromLocalFilesystem.mockResolvedValue(file)

    render(<Actions />)
    fireEvent.click(screen.getByLabelText('Embed image as first cell'))

    await waitFor(() => {
      expect(imageEmbeddingMocks.embedImageInNotebook).toHaveBeenCalledWith(
        notebookData,
        file
      )
    })
    expect(toastMocks.showToast).toHaveBeenCalledWith({
      message: 'Embedded screenshot.png.',
      tone: 'success',
    })
  })

  it('attaches dropped image files and shows the drop target', async () => {
    const uri = 'local://file/images.json'
    const notebookData = {
      getCell: vi.fn(),
      appendCell: vi.fn(),
    }
    const file = new File([new Uint8Array([1, 2, 3])], 'diagram.png', {
      type: 'image/png',
    })
    const dataTransfer = {
      items: [{ kind: 'file', type: 'image/png' }],
      files: [file],
      dropEffect: 'none',
    }
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'images.json', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue(notebookData)

    render(<Actions />)
    const notebookContent = screen.getByTestId('notebook-content')
    fireEvent.dragOver(notebookContent, { dataTransfer })
    expect(screen.getByTestId('resource-drop-target')).toBeTruthy()
    expect(dataTransfer.dropEffect).toBe('copy')

    fireEvent.drop(notebookContent, { dataTransfer })

    await waitFor(() => {
      expect(linkedResourceMocks.attachResourceToNotebook).toHaveBeenCalledWith(
        notebookData,
        { kind: 'file', value: file, name: 'diagram.png' },
        expect.objectContaining({
          target: { uri },
          folderUri: 'https://drive.google.com/drive/folders/assets-folder',
        })
      )
    })
    expect(screen.queryByTestId('resource-drop-target')).toBeNull()
  })

  it('prevents browser navigation and attaches non-image file drops', async () => {
    const uri = 'local://file/images.json'
    const notebookData = {
      getCell: vi.fn(),
      appendCell: vi.fn(),
    }
    const file = new File([new Uint8Array([1, 2, 3])], 'notes.txt', {
      type: 'text/plain',
    })
    const dataTransfer = {
      items: [{ kind: 'file', type: 'text/plain' }],
      files: [file],
      dropEffect: 'none',
    }
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'images.json', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue(notebookData)

    render(<Actions />)
    const notebookContent = screen.getByTestId('notebook-content')
    const dragOverEvent = createEvent.dragOver(notebookContent, {
      dataTransfer,
    })
    fireEvent(notebookContent, dragOverEvent)

    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(screen.getByTestId('resource-drop-target')).toBeTruthy()

    const dropEvent = createEvent.drop(notebookContent, { dataTransfer })
    fireEvent(notebookContent, dropEvent)

    expect(dropEvent.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(linkedResourceMocks.attachResourceToNotebook).toHaveBeenCalledWith(
        notebookData,
        { kind: 'file', value: file, name: 'notes.txt' },
        expect.objectContaining({ target: { uri } })
      )
    })
    expect(screen.queryByTestId('resource-drop-target')).toBeNull()
  })

  it('offers to retry insertion without uploading the Drive file again', async () => {
    const uri = 'local://file/retry-resource.json'
    const notebookData = {
      getCell: vi.fn(),
      appendCell: vi.fn(),
    }
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.webm', {
      type: 'video/webm',
    })
    const uploadedUri = 'https://drive.google.com/file/d/uploaded-resource/view'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'retry-resource.json', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue(notebookData)
    linkedResourceMocks.pickResourceFromLocalFilesystem.mockResolvedValue(file)
    linkedResourceMocks.attachResourceToNotebook.mockRejectedValueOnce(
      Object.assign(new Error('Notebook revision changed'), {
        uploadedResource: {
          uri: uploadedUri,
          name: 'demo.webm',
        },
      })
    )

    render(<Actions />)
    fireEvent.click(screen.getByLabelText('Attach file as first cell'))

    const retry = await screen.findByRole('button', {
      name: 'Retry insertion',
    })
    expect(
      screen
        .getByRole('link', { name: 'Open uploaded file' })
        .getAttribute('href')
    ).toBe(uploadedUri)

    fireEvent.click(retry)

    await waitFor(() => {
      expect(
        linkedResourceMocks.attachResourceToNotebook
      ).toHaveBeenLastCalledWith(
        notebookData,
        { kind: 'drive', uri: uploadedUri },
        {
          target: { uri },
          title: 'demo.webm',
        }
      )
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Retry insertion' })
      ).toBeNull()
    })
  })

  it('scrolls to and highlights the selected notebook cell named by the URL fragment', async () => {
    const uri = 'local://file/deep-link.runme.md'
    const cell = create(parser_pb.CellSchema, {
      refId: 'target/cell',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: 'Deep-link target',
      metadata: {},
    })
    const cellData = new StubCellData(cell)
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'deep-link.runme.md', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [cell],
      }),
    })
    contextMocks.getNotebookData.mockReturnValue({
      getCell: vi.fn(() => cellData),
    })
    window.history.replaceState(null, '', '/#cell=target%2Fcell')

    render(<Actions />)

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: 'center',
        inline: 'nearest',
        behavior: 'auto',
      })
    })
    const targetElement = (
      Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    ).mock.instances.find(
      (element) => (element as HTMLElement).dataset.cellRefId === 'target/cell'
    ) as HTMLElement | undefined
    expect(targetElement).toBeTruthy()
    expect(targetElement?.dataset.cellRefId).toBe('target/cell')
    await waitFor(() => {
      expect(targetElement?.className).toContain('outline-nb-accent')
    })
  })

  it('scopes a cell fragment to the notebook selected by the doc link', async () => {
    const restoredUri = 'local://file/restored.runme.md'
    const targetUri = 'local://file/deep-link-target.runme.md'
    const targetCell = create(parser_pb.CellSchema, {
      refId: 'target-cell',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: 'Deep-link target',
      metadata: {},
    })
    const targetCellData = new StubCellData(targetCell)
    contextMocks.currentDoc = restoredUri
    contextMocks.workspaceDocuments = [
      { uri: restoredUri, title: 'restored.runme.md', state: 'loaded' },
      { uri: targetUri, title: 'deep-link-target.runme.md', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(restoredUri, {
      uri: restoredUri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })
    contextMocks.notebookSnapshots.set(targetUri, {
      uri: targetUri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [targetCell],
      }),
    })
    contextMocks.getNotebookData.mockImplementation((uri: string) =>
      uri === targetUri
        ? {
            getCell: vi.fn(() => targetCellData),
          }
        : {
            getCell: vi.fn(),
          }
    )
    window.history.replaceState(
      null,
      '',
      `/?doc=${encodeURIComponent(targetUri)}#cell=target-cell`
    )

    const view = render(<Actions />)
    const deepLinkScrollCalls = () =>
      (
        Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
      ).mock.calls.filter(([options]) => options?.block === 'center')

    expect(deepLinkScrollCalls()).toHaveLength(0)
    expect(toastMocks.showToast).not.toHaveBeenCalled()

    contextMocks.currentDoc = targetUri
    window.history.replaceState(null, '', '/#cell=target-cell')
    view.rerender(<Actions />)

    await waitFor(() => {
      expect(deepLinkScrollCalls()).toHaveLength(1)
    })
    expect(toastMocks.showToast).not.toHaveBeenCalled()

    contextMocks.currentDoc = restoredUri
    view.rerender(<Actions />)

    await waitFor(() => {
      expect(
        screen
          .getByRole('tab', { name: 'restored.runme.md' })
          .getAttribute('data-state')
      ).toBe('active')
    })
    expect(deepLinkScrollCalls()).toHaveLength(1)
    expect(toastMocks.showToast).not.toHaveBeenCalled()
  })

  it('reports a deep link whose cell no longer exists', async () => {
    const uri = 'local://file/missing-deep-link.runme.md'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'missing-deep-link.runme.md', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })
    contextMocks.getNotebookData.mockReturnValue({
      getCell: vi.fn(),
    })
    window.history.replaceState(null, '', '/#cell=deleted-cell')

    render(<Actions />)

    await waitFor(() => {
      expect(toastMocks.showToast).toHaveBeenCalledWith({
        message: 'The linked cell no longer exists in this notebook.',
        tone: 'error',
      })
    })
  })

  it('enables horizontal scrolling for wide notebook content', () => {
    const uri = 'local://file/wide-table.runme.md'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'wide-table.runme.md', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })

    render(<Actions />)

    const scrollViewport = Array.from(
      document.querySelectorAll('[data-document-id]')
    ).find(
      (element) =>
        element.getAttribute('data-document-id') === uri &&
        String(element.className).includes('rt-ScrollAreaViewport')
    )
    const scrollRoot = scrollViewport?.parentElement

    expect(scrollViewport).toBeTruthy()
    expect(scrollRoot).toBeTruthy()
    expect(scrollRoot?.className).not.toContain('overflow-x-hidden')
    expect((scrollViewport as HTMLElement | undefined)?.style.overflowX).toBe(
      'scroll'
    )
  })

  it('marks read-only notebook tabs and content clearly', async () => {
    const uri = 'local://file/reference.runme.md'
    const owner: NotebookOwnershipRecord = {
      notebookUri: uri,
      ownerTabId: 'tab-other',
      ownerSessionId: 'calm-harbor',
      ownerLabel: 'Other tab',
      ownerUrl: 'http://localhost/?session=calm-harbor',
      ownerStartedAt: '2026-05-22T12:00:00.000Z',
      epoch: 'epoch-other',
    }
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'reference.runme.md',
        state: 'loaded',
        readOnly: true,
        owner,
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      readOnly: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })

    render(<Actions />)

    const readOnlyIndicators = screen.getAllByLabelText('Read-only notebook')
    expect(readOnlyIndicators.length).toBeGreaterThan(0)
    expect(screen.getByTitle('reference.runme.md').dataset.state).toBe('active')
    fireEvent.pointerMove(readOnlyIndicators[0], { pointerType: 'mouse' })
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain(
      'Read-only. This notebook is open for editing in another browser tab.'
    )
    expect(
      document.querySelector('#notebook-tabs-scroll')?.contains(tooltip)
    ).toBe(false)
    expect(
      screen.getByTestId('notebook-readonly-banner').textContent
    ).toContain('session calm-harbor')
    expect(screen.queryByLabelText('Add first cell')).toBeNull()
  })

  it('requests write access from a read-only notebook banner', () => {
    const uri = 'local://file/reference.runme.md'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'reference.runme.md',
        state: 'loaded',
        readOnly: true,
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      readOnly: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })

    render(<Actions />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Request write access' })
    )

    expect(contextMocks.requestWriteAccess).toHaveBeenCalledWith(uri)
  })

  it('renders owner locked mode immediately without prompting', () => {
    const uri = 'local://file/owned.runme.md'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'owned.runme.md',
        state: 'loaded',
        releasePending: true,
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      releasePending: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })

    render(<Actions />)

    expect(
      screen.getByTestId('notebook-owner-locked-banner').textContent
    ).toContain('Saving changes and switching this notebook to read-only')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('Add first cell')).toBeNull()
  })

  it('surfaces a timeout and requires the user to retry', () => {
    const uri = 'local://file/timeout.runme.md'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'timeout.runme.md',
        state: 'loaded',
        readOnly: true,
        writeAccessRequestState: 'error',
        writeAccessErrorMessage:
          'The other session did not respond. The notebook is still read-only.',
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      readOnly: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })

    render(<Actions />)

    expect(
      screen.getByTestId('notebook-readonly-banner').textContent
    ).toContain('The other session did not respond')
    expect(
      screen.getByRole('button', { name: 'Request write access' })
    ).toBeTruthy()
    expect(contextMocks.requestWriteAccess).not.toHaveBeenCalled()
  })

  it('shows the owner session when a notebook is blocked by another tab', () => {
    const uri = 'local://file/blocked.runme.md'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'blocked.runme.md',
        state: 'blocked',
        owner: {
          notebookUri: uri,
          ownerTabId: 'tab-other',
          ownerSessionId: 'quiet-signal',
          ownerLabel: 'Other tab',
          ownerUrl: 'http://localhost/?session=quiet-signal',
          ownerStartedAt: '2026-05-22T12:00:00.000Z',
          epoch: 'epoch-other',
        },
      },
    ]

    render(<Actions />)

    expect(screen.getByTestId('notebook-blocked-state').textContent).toContain(
      'Open in session: quiet-signal'
    )
  })

  it('shows Drive syncing state instead of empty notebook prompt', async () => {
    const uri = 'local://file/drive-syncing.runme.md'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'drive-syncing.runme.md',
        requestedUri: 'https://drive.google.com/file/d/file123/view',
        state: 'loaded',
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })
    contextMocks.notebookStore = {
      getMetadata: vi.fn(),
      getSyncState: vi.fn(async () => ({
        status: 'syncing',
        localUri: uri,
        remoteId: 'https://drive.google.com/file/d/file123/view',
      })),
      rename: vi.fn(),
      sync: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }

    render(<Actions />)

    expect(
      await screen.findByTestId('notebook-drive-loading-state')
    ).toBeTruthy()
    expect(screen.getByText('Loading notebook from Google Drive')).toBeTruthy()
    expect(screen.queryByText('This notebook has no cells yet.')).toBeNull()
    expect(screen.queryByLabelText('Add first cell')).toBeNull()
  })

  it('keeps local operation-log refresh separate from Drive sync', async () => {
    const uri = 'local://file/shared-runme'
    const remoteId = 'https://drive.google.com/file/d/file123/view'
    const sync = vi.fn(async () => undefined)
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'shared.runme',
        requestedUri: remoteId,
        state: 'loaded',
        refreshErrorMessage:
          'Could not refresh operation log: OPFS unavailable',
      },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })
    contextMocks.notebookStore = {
      getMetadata: vi.fn(),
      getSyncState: vi.fn(async () => ({
        status: 'synced',
        localUri: uri,
        remoteId,
      })),
      rename: vi.fn(),
      sync,
      subscribeSync: vi.fn(() => () => {}),
    }

    render(<Actions />)

    const refresh = await screen.findByRole('button', {
      name: 'Refresh shared.runme from local operation log',
    })
    const driveSync = await screen.findByRole('button', {
      name: 'Notebook is synced with Google Drive. Click to sync now.',
    })

    expect(
      refresh.compareDocumentPosition(driveSync) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(refresh)
    expect(contextMocks.refreshReadOnlyNotebook).toHaveBeenCalledWith(uri)
    expect(sync).not.toHaveBeenCalled()

    fireEvent.click(driveSync)
    expect(sync).toHaveBeenCalledWith(uri)
    expect(screen.queryByTestId('notebook-operation-log-banner')).toBeNull()
    expect(
      screen.getByTestId('notebook-operation-log-refresh-error').textContent
    ).toContain('OPFS unavailable')
  })

  it('does not make non-Drive status indicators trigger upstream sync', async () => {
    const localUri = 'local://file/local-runme'
    const filesystemUri = 'local://file/filesystem-runme'
    const sync = vi.fn(async () => undefined)
    contextMocks.currentDoc = localUri
    contextMocks.workspaceDocuments = [
      { uri: localUri, title: 'local.runme', state: 'loaded' },
      { uri: filesystemUri, title: 'filesystem.runme', state: 'loaded' },
    ]
    for (const uri of [localUri, filesystemUri]) {
      contextMocks.notebookSnapshots.set(uri, {
        uri,
        loaded: true,
        notebook: create(parser_pb.NotebookSchema, {
          metadata: {},
          cells: [],
        }),
      })
    }
    contextMocks.notebookStore = {
      getMetadata: vi.fn(),
      getSyncState: vi.fn(async (uri: string) =>
        uri === localUri
          ? { status: 'local-only', localUri: uri, remoteId: uri }
          : {
              status: 'synced',
              localUri: uri,
              remoteId: 'fs://workspace/shared.runme',
            }
      ),
      rename: vi.fn(),
      sync,
      subscribeSync: vi.fn(() => () => {}),
    }

    render(<Actions />)

    const localStatus = await screen.findByRole('button', {
      name: 'Notebook is stored only in this browser',
    })
    const filesystemStatus = await screen.findByRole('button', {
      name: 'Notebook is synced',
    })
    fireEvent.click(localStatus)
    fireEvent.click(filesystemStatus)

    expect(sync).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(/Click to sync now/)).toBeNull()
  })

  it('defers rendering inactive read-only notebook cells', () => {
    const activeUri = 'local://file/active.runme.md'
    const readOnlyUri = 'local://file/reference.runme.md'
    const readOnlyCell = create(parser_pb.CellSchema, {
      refId: 'readonly-markdown',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: 'expensive readonly content',
      metadata: {},
    })
    const readOnlyCellData = new StubCellData(readOnlyCell)
    const getReadOnlyCell = vi.fn(() => readOnlyCellData)

    contextMocks.currentDoc = activeUri
    contextMocks.workspaceDocuments = [
      { uri: activeUri, title: 'active.runme.md', state: 'loaded' },
      {
        uri: readOnlyUri,
        title: 'reference.runme.md',
        state: 'loaded',
        readOnly: true,
      },
    ]
    contextMocks.notebookSnapshots.set(activeUri, {
      uri: activeUri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })
    contextMocks.notebookSnapshots.set(readOnlyUri, {
      uri: readOnlyUri,
      loaded: true,
      readOnly: true,
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [readOnlyCell],
      }),
    })
    contextMocks.getNotebookData.mockImplementation((uri: string) => {
      if (uri === readOnlyUri) {
        return { getCell: getReadOnlyCell }
      }
      return { getCell: vi.fn() }
    })

    render(<Actions />)

    expect(screen.getByTestId('notebook-readonly-inactive-state')).toBeTruthy()
    expect(screen.queryByText('expensive readonly content')).toBeNull()
    expect(getReadOnlyCell).not.toHaveBeenCalled()
  })

  it('falls back from a stale current URI to an open workspace document', async () => {
    contextMocks.currentDoc = 'diff://notebook/not-restored'
    contextMocks.workspaceDocuments = [
      { uri: 'local://file/restored', title: 'restored.json' },
    ]

    render(<Actions />)

    await waitFor(() => {
      expect(contextMocks.setCurrentDoc).toHaveBeenCalledWith(
        'local://file/restored'
      )
    })
  })

  it('preserves a current notebook while its workspace tab is restoring', async () => {
    const restoredUri = 'local://file/restored.runme.md'
    contextMocks.currentDoc = restoredUri
    contextMocks.openNotebooks = [
      {
        uri: restoredUri,
        requestedUri: restoredUri,
        name: 'restored.runme.md',
        state: 'loading',
      },
    ]
    contextMocks.workspaceDocuments = [
      {
        uri: 'https://github.com/runmedev/web/blob/abc123/docs/00-getting-started.md',
        title: 'Getting Started',
        readOnly: true,
      },
    ]

    render(<Actions />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Getting Started/ })).toBeTruthy()
    })
    expect(contextMocks.setCurrentDoc).not.toHaveBeenCalled()
  })

  it('opens suggestion review from a .runme tab context menu', async () => {
    const uri = 'local://file/reviewable'
    const suggestionUri = getOperationLogSuggestionDocumentUri(uri)
    contextMocks.notebookStore = {
      getMetadata: vi.fn(async () => ({
        uri,
        name: 'reviewable.runme',
        type: 'file',
        children: [],
        parents: [],
      })),
      getSyncState: vi.fn(async () => ({
        status: 'local-only',
        localUri: uri,
        remoteId: uri,
      })),
      listOperationLogComments: vi.fn(async () => []),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'reviewable.runme', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue({
      appendCell: vi.fn(),
      getSnapshot: vi.fn(() => ({ loaded: true })),
    })

    render(<Actions />)

    fireEvent.contextMenu(
      screen.getByRole('tab', { name: /reviewable\.runme/ })
    )
    const contextMenu = document.querySelector<HTMLElement>('.ctx-menu')
    expect(contextMenu).not.toBeNull()
    fireEvent.click(
      within(contextMenu as HTMLElement).getByRole('button', {
        name: 'Review suggestions',
      })
    )

    expect(contextMocks.showDocument).toHaveBeenCalledWith(suggestionUri, {
      title: 'Suggestions · reviewable.runme',
      afterUri: uri,
    })
    expect(contextMocks.setCurrentDoc).toHaveBeenCalledWith(suggestionUri)
  })

  it('omits suggestion review while a .runme notebook is loading', () => {
    const uri = 'local://file/loading-review'
    contextMocks.notebookStore = {
      getMetadata: vi.fn(async () => ({
        uri,
        name: 'loading-review.runme',
        type: 'file',
        children: [],
        parents: [],
      })),
      getSyncState: vi.fn(async () => null),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'loading-review.runme', state: 'loading' },
    ]
    contextMocks.getNotebookData.mockReturnValue({
      getSnapshot: vi.fn(() => ({ loaded: false })),
    })

    render(<Actions />)

    fireEvent.contextMenu(
      screen.getByRole('tab', { name: /loading-review\.runme/ })
    )
    const contextMenu = document.querySelector<HTMLElement>('.ctx-menu')
    expect(contextMenu).not.toBeNull()
    expect(
      within(contextMenu as HTMLElement).queryByRole('button', {
        name: 'Review suggestions',
      })
    ).toBeNull()
  })

  it('omits suggestion review from legacy notebook tab context menus', async () => {
    const uri = 'local://file/legacy'
    const getMetadata = vi.fn(async () => ({
      uri,
      name: 'legacy.json',
      type: 'file',
      children: [],
      parents: [],
    }))
    contextMocks.notebookStore = {
      getMetadata,
      getSyncState: vi.fn(async () => ({
        status: 'local-only',
        localUri: uri,
        remoteId: uri,
      })),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      { uri, title: 'legacy.json', state: 'loaded' },
    ]
    contextMocks.notebookSnapshots.set(uri, {
      uri,
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, { metadata: {}, cells: [] }),
    })
    contextMocks.getNotebookData.mockReturnValue({ appendCell: vi.fn() })

    render(<Actions />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /legacy\.json/ }))
    await waitFor(() => expect(getMetadata).toHaveBeenCalledWith(uri))

    expect(
      screen.queryByRole('button', { name: 'Review suggestions' })
    ).toBeNull()
  })

  it('renames the notebook from the tab context menu', async () => {
    const rename = vi.fn(async () => ({
      uri: 'local://file/restored',
      name: 'renamed.json',
      type: 'file',
      children: [],
      remoteUri: 'https://drive.google.com/file/d/file123/view',
      parents: [],
    }))
    const setName = vi.fn()
    contextMocks.notebookStore = {
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/restored',
        name: 'restored.json',
        type: 'file',
        children: [],
        remoteUri: 'https://drive.google.com/file/d/file123/view',
        parents: [],
      })),
      getSyncState: vi.fn(async () => ({
        status: 'synced',
        localUri: 'local://file/restored',
        remoteId: 'https://drive.google.com/file/d/file123/view',
      })),
      rename,
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.getNotebookData.mockReturnValue({ setName })
    contextMocks.currentDoc = 'local://file/restored'
    contextMocks.workspaceDocuments = [
      { uri: 'local://file/restored', title: 'restored.json' },
    ]
    vi.spyOn(window, 'prompt').mockReturnValue('renamed.json')

    render(<Actions />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /restored\.json/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))

    await waitFor(() => {
      expect(rename).toHaveBeenCalledWith(
        'local://file/restored',
        'renamed.json'
      )
    })
    expect(setName).toHaveBeenCalledWith('renamed.json')
    expect(contextMocks.showDocument).toHaveBeenCalledWith(
      'local://file/restored',
      { title: 'renamed.json' }
    )
  })

  it('copies a markdown link from the tab context menu', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    window.history.replaceState(null, '', '/')
    contextMocks.notebookStore = {
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/restored',
        name: '202602a_tb_aws_codex_136.json',
        type: 'file',
        children: [],
        remoteUri:
          'https://drive.google.com/file/d/1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV/view',
        parents: [],
      })),
      getSyncState: vi.fn(async () => ({
        status: 'synced',
        localUri: 'local://file/restored',
        remoteId:
          'https://drive.google.com/file/d/1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV/view',
      })),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.currentDoc = 'local://file/restored'
    contextMocks.workspaceDocuments = [
      {
        uri: 'local://file/restored',
        title: '202602a_tb_aws_codex_136.json',
      },
    ]

    render(<Actions />)

    fireEvent.contextMenu(
      screen.getByRole('tab', { name: '202602a_tb_aws_codex_136.json' })
    )
    await screen.findByRole('button', { name: 'Copy Google Drive Link' })
    expect(
      screen.queryByRole('button', { name: 'Copy Google Colab Link' })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown Link' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '[202602a_tb_aws_codex_136](http://localhost:3000/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV%2Fview)'
      )
    })
  })

  it('copies a Google Colab link for a Drive-backed ipynb tab', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const remoteUri =
      'https://drive.google.com/file/d/1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV/view'
    contextMocks.notebookStore = {
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/restored',
        name: 'analysis.ipynb',
        type: 'file',
        children: [],
        remoteUri,
        parents: [],
      })),
      getSyncState: vi.fn(async () => ({
        status: 'synced',
        localUri: 'local://file/restored',
        remoteId: remoteUri,
      })),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.currentDoc = 'local://file/restored'
    contextMocks.workspaceDocuments = [
      {
        uri: 'local://file/restored',
        title: 'analysis.ipynb',
      },
    ]

    render(<Actions />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'analysis.ipynb' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Copy Google Colab Link' })
    )

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'https://colab.research.google.com/drive/1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV'
      )
    })
  })

  it('opens an upstream diff from the Drive-backed tab context menu', async () => {
    const uri = 'local://file/restored'
    const remoteUri =
      'https://drive.google.com/file/d/1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV/view'
    contextMocks.notebookStore = {
      getMetadata: vi.fn(async () => ({
        uri,
        name: 'restored.json',
        type: 'file',
        children: [],
        remoteUri,
        parents: [],
      })),
      getSyncState: vi.fn(async () => ({
        status: 'synced',
        localUri: uri,
        remoteId: remoteUri,
      })),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'restored.json',
      },
    ]

    render(<Actions />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /restored\.json/ }))
    const compareButton = await screen.findByRole('button', {
      name: 'Compare with upstream',
    })
    fireEvent.click(compareButton)

    await waitFor(() => {
      expect(conflictMocks.openNotebookUpstreamDiff).toHaveBeenCalledWith(
        contextMocks.notebookStore,
        uri
      )
    })
  })

  it('copies the owner session id from a read-only tab context menu', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const uri = 'local://file/restored'
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [
      {
        uri,
        title: 'restored.json',
        readOnly: true,
        owner: {
          notebookUri: uri,
          ownerTabId: 'tab-other',
          ownerSessionId: 'silver-river',
          ownerLabel: 'Other tab',
          ownerUrl: 'http://localhost/?session=silver-river',
          ownerStartedAt: '2026-05-22T12:00:00.000Z',
          epoch: 'epoch-other',
        },
      },
    ]

    render(<Actions />)

    await act(async () => {
      fireEvent.contextMenu(screen.getByRole('tab', { name: /restored\.json/ }))
    })
    const copyOwnerSessionButton = await screen.findByRole('button', {
      name: 'Copy Owner Session ID',
    })
    await act(async () => {
      fireEvent.click(copyOwnerSessionButton)
    })

    expect(writeText).toHaveBeenCalledWith('silver-river')
  })

  it('opens a conflict diff from the notebook sync indicator', async () => {
    const store = {
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/conflict',
        name: 'conflict.json',
        type: 'file',
        children: [],
        remoteUri: 'https://drive.google.com/file/d/file123/view',
        parents: [],
      })),
      getSyncState: vi.fn(async () => ({
        status: 'conflicted',
        localUri: 'local://file/conflict',
        remoteId: 'https://drive.google.com/file/d/file123/view',
        conflict: {
          detectedAt: '2026-05-30T00:00:00.000Z',
          upstreamChecksum: 'upstream-checksum',
          upstreamDoc: '{}',
          localChecksumAtDetection: 'local-checksum',
        },
      })),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    contextMocks.notebookStore = store
    contextMocks.currentDoc = 'local://file/conflict'
    contextMocks.workspaceDocuments = [
      { uri: 'local://file/conflict', title: 'conflict.json' },
    ]

    render(<Actions />)

    const indicator = await screen.findByRole('button', {
      name: 'Notebook has a sync conflict. Click to review differences.',
    })
    fireEvent.click(indicator)

    await waitFor(() => {
      expect(conflictMocks.openNotebookConflictDiff).toHaveBeenCalledWith(
        store,
        'local://file/conflict'
      )
    })
  })

  it('renders a selected notebook diff workspace document as a tab', () => {
    const baseNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'cell-1',
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('base')",
        }),
      ],
      metadata: {},
    })
    const compareNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'cell-1',
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('compare')",
        }),
      ],
      metadata: {},
    })
    const doc = registerNotebookDiffDocument({
      id: 'diff-1',
      base: { label: 'Drive revision 1', revisionId: '1' },
      compare: { label: 'Local copy', revisionId: 'local' },
      diff: computeNotebookDiff(baseNotebook, compareNotebook),
    })
    const diffUri = getNotebookDiffDocumentUri(doc.id)
    contextMocks.currentDoc = diffUri
    contextMocks.workspaceDocuments = [
      { uri: diffUri, title: 'Drive revision 1 vs Local copy' },
    ]

    render(<Actions />)

    expect(
      screen.getByRole('tab', { name: 'Drive revision 1 vs Local copy' })
    ).toBeTruthy()
    expect(screen.getByText('Notebook Diff')).toBeTruthy()
    expect(
      screen.getByText(/Drive revision 1 compared with Local copy/)
    ).toBeTruthy()
    expect(screen.getByText("print('base')")).toBeTruthy()
    expect(screen.getByText("print('compare')")).toBeTruthy()
    expect(screen.queryByText('Back to notebooks')).toBeNull()
  })

  it('saves local version from a conflict diff tab', async () => {
    const resolveConflictWithLocal = vi.fn(async () => undefined)
    contextMocks.notebookStore = {
      getMetadata: vi.fn(),
      getSyncState: vi.fn(),
      rename: vi.fn(),
      resolveConflictWithLocal,
      subscribeSync: vi.fn(() => () => {}),
    }
    const doc = registerNotebookDiffDocument({
      id: 'conflict-diff',
      base: { label: 'Upstream version', revisionId: 'upstream' },
      compare: { label: 'Local version' },
      diff: computeNotebookDiff(
        create(parser_pb.NotebookSchema, {
          cells: [
            create(parser_pb.CellSchema, {
              refId: 'cell-1',
              kind: parser_pb.CellKind.CODE,
              languageId: 'python',
              value: "print('upstream')",
            }),
          ],
          metadata: {},
        }),
        create(parser_pb.NotebookSchema, {
          cells: [
            create(parser_pb.CellSchema, {
              refId: 'cell-1',
              kind: parser_pb.CellKind.CODE,
              languageId: 'python',
              value: "print('local')",
            }),
          ],
          metadata: {},
        })
      ),
      resolution: {
        kind: 'notebook-sync-conflict',
        localUri: 'local://file/conflict',
      },
    })
    const diffUri = getNotebookDiffDocumentUri(doc.id)
    contextMocks.currentDoc = diffUri
    contextMocks.workspaceDocuments = [
      { uri: diffUri, title: 'Upstream version vs Local version' },
    ]

    render(<Actions />)

    fireEvent.click(screen.getByRole('button', { name: 'Save local version' }))

    await waitFor(() => {
      expect(resolveConflictWithLocal).toHaveBeenCalledWith(
        'local://file/conflict',
        { force: false }
      )
    })
  })

  it('refreshes a conflict diff tab against latest upstream and local versions', async () => {
    const refreshConflictWithLatestUpstream = vi.fn(async () => ({
      detectedAt: '2026-05-30T00:00:00.000Z',
      upstreamChecksum: 'upstream-head-checksum',
      upstreamVersion: {
        checksum: 'upstream-head-checksum',
        revisionId: 'upstream-head',
      },
      upstreamDoc: '',
      localChecksumAtDetection: 'local-checksum',
    }))
    contextMocks.notebookStore = {
      getMetadata: vi.fn(),
      getSyncState: vi.fn(),
      rename: vi.fn(),
      refreshConflictWithLatestUpstream,
      subscribeSync: vi.fn(() => () => {}),
    }
    const doc = registerNotebookDiffDocument({
      id: 'conflict-refresh-diff',
      base: { label: 'Upstream version', revisionId: 'upstream' },
      compare: { label: 'Local version' },
      diff: computeNotebookDiff(
        create(parser_pb.NotebookSchema, {
          cells: [
            create(parser_pb.CellSchema, {
              refId: 'cell-1',
              kind: parser_pb.CellKind.CODE,
              languageId: 'python',
              value: "print('upstream')",
            }),
          ],
          metadata: {},
        }),
        create(parser_pb.NotebookSchema, {
          cells: [
            create(parser_pb.CellSchema, {
              refId: 'cell-1',
              kind: parser_pb.CellKind.CODE,
              languageId: 'python',
              value: "print('local')",
            }),
          ],
          metadata: {},
        })
      ),
      resolution: {
        kind: 'notebook-sync-conflict',
        localUri: 'local://file/conflict',
      },
    })
    const diffUri = getNotebookDiffDocumentUri(doc.id)
    contextMocks.currentDoc = diffUri
    contextMocks.workspaceDocuments = [
      { uri: diffUri, title: 'Upstream version vs Local version' },
    ]

    render(<Actions />)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }))

    await waitFor(() => {
      expect(conflictMocks.refreshNotebookConflictDiff).toHaveBeenCalledWith(
        contextMocks.notebookStore,
        'local://file/conflict'
      )
    })
  })

  it('keeps a clicked diff tab selected while current doc state catches up', async () => {
    const diff = computeNotebookDiff(
      create(parser_pb.NotebookSchema, {
        cells: [
          create(parser_pb.CellSchema, {
            refId: 'cell-1',
            kind: parser_pb.CellKind.CODE,
            languageId: 'python',
            value: "print('base')",
          }),
        ],
        metadata: {},
      }),
      create(parser_pb.NotebookSchema, {
        cells: [
          create(parser_pb.CellSchema, {
            refId: 'cell-1',
            kind: parser_pb.CellKind.CODE,
            languageId: 'python',
            value: "print('compare')",
          }),
        ],
        metadata: {},
      })
    )
    const doc = registerNotebookDiffDocument({
      id: 'diff-click',
      base: { label: 'Drive revision 1', revisionId: '1' },
      compare: { label: 'Local copy', revisionId: 'local' },
      diff,
    })
    const diffUri = getNotebookDiffDocumentUri(doc.id)
    contextMocks.currentDoc = 'local://file/first'
    contextMocks.workspaceDocuments = [
      { uri: 'local://file/first', title: 'first.json' },
      { uri: diffUri, title: 'Drive revision 1 vs Local copy' },
    ]

    render(<Actions />)

    const firstTab = screen.getByRole('tab', { name: 'first.json' })
    const diffTab = screen.getByRole('tab', {
      name: 'Drive revision 1 vs Local copy',
    })
    expect(firstTab.getAttribute('aria-selected')).toBe('true')

    fireEvent.mouseDown(diffTab, { button: 0, ctrlKey: false })

    expect(contextMocks.setCurrentDoc).toHaveBeenCalledWith(diffUri)
    await waitFor(() => {
      expect(diffTab.getAttribute('aria-selected')).toBe('true')
      expect(firstTab.getAttribute('aria-selected')).toBe('false')
    })
  })

  it('renders the version information workspace document as a tab', () => {
    contextMocks.currentDoc = VERSION_INFO_DOCUMENT_URI
    contextMocks.workspaceDocuments = [
      { uri: VERSION_INFO_DOCUMENT_URI, title: 'Version Information' },
    ]

    render(<Actions />)

    expect(
      screen.getByRole('tab', { name: 'Version Information' })
    ).toBeTruthy()
    expect(screen.getByText('Release')).toBeTruthy()
    expect(screen.getByText('version.yaml')).toBeTruthy()
  })

  it('renders App Console and Logs workspace documents as tabs', () => {
    contextMocks.currentDoc = APP_CONSOLE_DOCUMENT_URI
    contextMocks.workspaceDocuments = [
      { uri: APP_CONSOLE_DOCUMENT_URI, title: 'App Console' },
      { uri: LOGS_DOCUMENT_URI, title: 'Logs' },
    ]

    render(<Actions />)

    expect(screen.getByRole('tab', { name: 'App Console' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Logs' })).toBeTruthy()
    expect(screen.getByTestId('app-console-mock')).toBeTruthy()
    expect(
      screen.getByTestId('app-console-mock').getAttribute('data-show-header')
    ).toBe('false')
    expect(screen.getByTestId('logs-pane-mock')).toBeTruthy()
  })

  it('renders a runner kernel status workspace document as a tab', async () => {
    const uri = getRunnerKernelsDocumentUri('default')
    contextMocks.currentDoc = uri
    contextMocks.workspaceDocuments = [{ uri, title: 'Kernels · default' }]

    render(<Actions />)

    expect(screen.getByRole('tab', { name: 'Kernels · default' })).toBeTruthy()
    expect(screen.getByText('Jupyter Kernels')).toBeTruthy()
    expect(
      await screen.findByText('No kernels are running on this runner.')
    ).toBeTruthy()
  })
})

describe('Action component', () => {
  it('opens Runme notebook links in the current workspace', async () => {
    const targetUri = 'local://file/notes'
    const cell = create(parser_pb.CellSchema, {
      refId: 'markdown-notebook-link',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: `[Notes](/?doc=${encodeURIComponent(targetUri)}#cell=markup%2Fintro)`,
      metadata: {},
    })

    render(
      <Action
        cellData={new StubCellData(cell) as unknown as CellData}
        isFirst={false}
      />
    )

    fireEvent.click(screen.getByRole('link', { name: 'Notes' }))

    await waitFor(() => {
      expect(contextMocks.openNotebook).toHaveBeenCalledWith(targetUri)
    })
    expect(contextMocks.showDocument).toHaveBeenCalledWith(targetUri, {
      title: 'Notes.json',
    })
    expect(contextMocks.setCurrentDoc).toHaveBeenCalledWith(targetUri)
    expect(window.location.hash).toBe('#cell=markup%2Fintro')
  })

  it('routes Drive-backed Runme links through shared-link coordination', async () => {
    const targetUri = 'https://drive.google.com/file/d/file123/view'
    const enqueue = vi
      .spyOn(driveLinkCoordinator, 'enqueue')
      .mockResolvedValue(undefined)
    const getSnapshot = vi
      .spyOn(driveLinkCoordinator, 'getSnapshot')
      .mockReturnValue({
        intents: [],
        authBlocked: false,
        lastErrorMessage: null,
      })
    const cell = create(parser_pb.CellSchema, {
      refId: 'markdown-drive-link',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: `[Notes](/?doc=${encodeURIComponent(targetUri)})`,
      metadata: {},
    })

    render(
      <Action
        cellData={new StubCellData(cell) as unknown as CellData}
        isFirst={false}
      />
    )

    fireEvent.click(screen.getByRole('link', { name: 'Notes' }))

    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith(targetUri, 'manual')
    })
    expect(contextMocks.openNotebook).not.toHaveBeenCalled()

    enqueue.mockRestore()
    getSnapshot.mockRestore()
  })

  it('copies a deep link for the cell from its context menu', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    contextMocks.notebookStore = {
      getMetadata: vi.fn(async () => ({ remoteUri })),
      getSyncState: vi.fn(),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell/with spaces',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: 'Link to me',
      metadata: {},
    })
    const stub = new StubCellData(cell)
    window.history.replaceState(null, '', '/workspace?ignored=1#old')

    render(
      <Action
        cellData={stub as unknown as CellData}
        docUri="local://file/notebook"
        isFirst={false}
      />
    )

    fireEvent.contextMenu(screen.getByTestId('markdown-action'))
    const contextMenu = document.querySelector('.ctx-menu')
    expect(contextMenu).toBeTruthy()
    fireEvent.click(
      await within(contextMenu as HTMLElement).findByRole('button', {
        name: 'Copy link to cell',
      })
    )

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'http://localhost:3000/workspace?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Ffile123%2Fview#cell=cell%2Fwith%20spaces'
      )
    })
    expect(toastMocks.showToast).toHaveBeenCalledWith({
      message: 'Link to cell copied',
      tone: 'success',
    })
  })

  it.each([
    ['code', parser_pb.CellKind.CODE, 'javascript', 'code-action'],
    ['Markdown', parser_pb.CellKind.MARKUP, 'markdown', 'markdown-action'],
    ['HTML', parser_pb.CellKind.CODE, 'html', 'html-action'],
  ])(
    'copies a markdown link with inferred titles from a %s cell',
    async (_, kind, languageId, testId) => {
      const writeText = vi.fn(async () => undefined)
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
      const cell = create(parser_pb.CellSchema, {
        refId: 'setup-cell',
        kind,
        languageId,
        value: '\n// Prepare [workspace]\nconsole.log("ready")',
        metadata: {},
      })
      window.history.replaceState(null, '', '/workspace')

      render(
        <Action
          cellData={new StubCellData(cell) as unknown as CellData}
          docUri="local://file/notebook"
          docTitle="Demo notebook.json"
          isFirst={false}
        />
      )

      fireEvent.contextMenu(screen.getByTestId(testId))
      const contextMenu = document.querySelector('.ctx-menu')
      expect(contextMenu).toBeTruthy()
      fireEvent.click(
        within(contextMenu as HTMLElement).getByRole('button', {
          name: 'Copy Markdown Link',
        })
      )

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          '[Demo notebook#Prepare \\[workspace\\]](http://localhost:3000/workspace?doc=local%3A%2F%2Ffile%2Fnotebook#cell=setup-cell)'
        )
      })
      expect(toastMocks.showToast).toHaveBeenCalledWith({
        message: 'Markdown link to cell copied',
        tone: 'success',
      })
    }
  )

  it('waits for Drive metadata before offering a cell link', async () => {
    let resolveMetadata: ((value: { remoteUri: string }) => void) | undefined
    const metadata = new Promise<{ remoteUri: string }>((resolve) => {
      resolveMetadata = resolve
    })
    contextMocks.notebookStore = {
      getMetadata: vi.fn(() => metadata),
      getSyncState: vi.fn(),
      rename: vi.fn(),
      subscribeSync: vi.fn(() => () => {}),
    }
    const cell = create(parser_pb.CellSchema, {
      refId: 'metadata-target',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: 'Link to me',
      metadata: {},
    })

    render(
      <Action
        cellData={new StubCellData(cell) as unknown as CellData}
        docUri="local://file/notebook"
        isFirst={false}
      />
    )

    expect(
      screen.queryByRole('button', { name: 'Copy link to cell' })
    ).toBeNull()

    resolveMetadata?.({
      remoteUri: 'https://drive.google.com/file/d/file123/view',
    })

    expect(
      await screen.findByRole('button', { name: 'Copy link to cell' })
    ).toBeTruthy()
  })

  it('does not offer a cell link without a ref ID', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: '',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: 'Unidentified cell',
      metadata: {},
    })

    render(
      <Action
        cellData={new StubCellData(cell) as unknown as CellData}
        docUri="local://file/notebook"
        isFirst={false}
      />
    )

    expect(
      screen.queryByRole('button', { name: 'Copy link to cell' })
    ).toBeNull()
  })

  it.each([
    ['code', parser_pb.CellKind.CODE, 'bash'],
    ['markdown', parser_pb.CellKind.MARKUP, 'markdown'],
    ['HTML', parser_pb.CellKind.CODE, 'html'],
  ])(
    'exposes a primary cell link action for %s cells',
    async (_, kind, languageId) => {
      const writeText = vi.fn(async () => undefined)
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
      const cell = create(parser_pb.CellSchema, {
        refId: 'primary-link',
        kind,
        languageId,
        value: 'Link to me',
        metadata: {},
      })

      render(
        <Action
          cellData={new StubCellData(cell) as unknown as CellData}
          docUri="local://file/notebook"
          isFirst={false}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Copy link to cell' }))

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          'http://localhost:3000/?doc=local%3A%2F%2Ffile%2Fnotebook#cell=primary-link'
        )
      })
    }
  )

  it('reports a clipboard failure when copying a cell link', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject('denied')) },
    })
    const cell = create(parser_pb.CellSchema, {
      refId: 'copy-failure',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: 'Link to me',
      metadata: {},
    })

    render(
      <Action
        cellData={new StubCellData(cell) as unknown as CellData}
        docUri="local://file/notebook"
        isFirst={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy link to cell' }))

    await waitFor(() => {
      expect(toastMocks.showToast).toHaveBeenCalledWith({
        message:
          'Could not copy the cell link. Check clipboard permissions and try again.',
        tone: 'error',
      })
    })
  })

  it('disables code-cell mutations in read-only mode', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-readonly',
      kind: parser_pb.CellKind.CODE,
      languageId: 'bash',
      outputs: [],
      metadata: {},
      value: 'echo hi',
    })
    const stub = new StubCellData(cell)

    render(
      <Action cellData={stub as unknown as CellData} isFirst={false} readOnly />
    )

    const runButton = screen.getByLabelText('Run code') as HTMLButtonElement
    const languageSelect = document.querySelector(
      '.toolbar-select'
    ) as HTMLSelectElement | null

    expect(runButton.disabled).toBe(true)
    expect(screen.getByLabelText('Add cell above')).toHaveProperty(
      'disabled',
      true
    )
    expect(screen.getByLabelText('Add cell below')).toHaveProperty(
      'disabled',
      true
    )
    fireEvent.click(runButton)
    expect(stub.run).not.toHaveBeenCalled()
    expect(stub.update).not.toHaveBeenCalled()
    expect(stub.addBefore).not.toHaveBeenCalled()
    expect(stub.addAfter).not.toHaveBeenCalled()
    expect(languageSelect?.disabled ?? true).toBe(true)
  })

  it('updates CellConsole key when runID changes', async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-1',
      kind: parser_pb.CellKind.CODE,
      languageId: 'bash',
      outputs: [],
      metadata: {
        [RunmeMetadataKey.LastRunID]: 'run-0',
      },
      value: 'echo hi',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const first = screen.getByTestId('cell-console') as HTMLElement
    const firstKey = first.dataset.runkey

    await act(async () => {
      stub.setRunID('run-123')
      await Promise.resolve()
    })

    const second = screen.getByTestId('cell-console') as HTMLElement
    const secondKey = second.dataset.runkey

    expect(firstKey).not.toBe(secondKey)
  })

  it('hides console output area when runID is cleared and outputs are empty', async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-clear',
      kind: parser_pb.CellKind.CODE,
      languageId: 'bash',
      outputs: [],
      metadata: {
        [RunmeMetadataKey.LastRunID]: 'run-0',
      },
      value: 'echo hi',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)
    expect(screen.getByTestId('cell-console')).toBeTruthy()

    await act(async () => {
      stub.setRunID('')
      await Promise.resolve()
    })

    expect(screen.queryByTestId('cell-console')).toBeNull()
  })

  it('suppresses duplicate stdout output items while a live console stream is active', () => {
    const stdoutOutput = create(parser_pb.CellOutputSchema, {
      items: [
        create(parser_pb.CellOutputItemSchema, {
          mime: 'application/vnd.code.notebook.stdout',
          type: 'Buffer',
          data: new TextEncoder().encode('prompt'),
        }),
      ],
    })
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-live-stdout',
      kind: parser_pb.CellKind.CODE,
      languageId: 'bash',
      outputs: [stdoutOutput],
      metadata: {
        [RunmeMetadataKey.LastRunID]: 'run-live-stdout',
      },
      value: 'echo hi',
    })
    const stub = new StubCellData(cell) as unknown as CellData

    render(<Action cellData={stub} isFirst={false} />)

    expect(screen.getByTestId('cell-console')).toBeTruthy()
    expect(
      screen.queryByText(/mime=application\/vnd\.code\.notebook\.stdout/)
    ).toBeNull()
  })

  it('does not show ANSI control sequences in stdout output items', () => {
    const stdoutOutput = create(parser_pb.CellOutputSchema, {
      items: [
        create(parser_pb.CellOutputItemSchema, {
          mime: 'application/vnd.code.notebook.stdout',
          type: 'Buffer',
          data: new TextEncoder().encode('\x1b[2m\x1b[33m|\x1b[0m\x1b[m ok\n'),
        }),
      ],
    })

    render(<ActionOutputItems outputs={[stdoutOutput]} />)

    const item = screen.getByTestId('cell-output-item')
    expect(item.textContent).toContain('| ok')
    expect(item.textContent).not.toContain('\x1b[')
  })

  it('shows language selector in markdown edit mode and converts to code language', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: '',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const selector = screen.getByRole('combobox')
    expect(selector).toBeTruthy()
    expect((selector as HTMLSelectElement).value).toBe('markdown')

    fireEvent.change(selector, { target: { value: 'bash' } })

    expect(stub.update).toHaveBeenCalledTimes(1)
    const updatedCell = stub.update.mock.calls[0][0] as parser_pb.Cell
    expect(updatedCell.kind).toBe(parser_pb.CellKind.CODE)
    expect(updatedCell.languageId).toBe('bash')
  })

  it('converts code cell to markdown kind when switching to markdown', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-code',
      kind: parser_pb.CellKind.CODE,
      languageId: 'bash',
      outputs: [],
      metadata: {},
      value: 'echo hi',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const selector = document.getElementById(
      'language-select-cell-code'
    ) as HTMLSelectElement | null
    expect(selector).toBeTruthy()
    fireEvent.change(selector as HTMLSelectElement, {
      target: { value: 'markdown' },
    })

    expect(stub.update).toHaveBeenCalledTimes(1)
    const updatedCell = stub.update.mock.calls[0][0] as parser_pb.Cell
    expect(updatedCell.kind).toBe(parser_pb.CellKind.MARKUP)
    expect(updatedCell.languageId).toBe('markdown')
  })

  it('converts markdown cells to html code cells', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-html-convert',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: '',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const selector = screen.getByRole('combobox')
    fireEvent.change(selector, { target: { value: 'html' } })

    expect(stub.update).toHaveBeenCalledTimes(1)
    const updatedCell = stub.update.mock.calls[0][0] as parser_pb.Cell
    expect(updatedCell.kind).toBe(parser_pb.CellKind.CODE)
    expect(updatedCell.languageId).toBe('html')
  })

  it('renders html cells in-place without the code run toolbar', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-html-rendered',
      kind: parser_pb.CellKind.CODE,
      languageId: 'html',
      outputs: [],
      metadata: {},
      value: '<div><strong>Hello HTML</strong></div>',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    expect(screen.getByTestId('html-action')).toBeTruthy()
    expect(screen.getByTestId('html-rendered')).toBeTruthy()
    const frame = screen.getByTestId('html-preview-frame') as HTMLIFrameElement
    expect(frame.getAttribute('srcdoc')).toBe(
      '<div><strong>Hello HTML</strong></div>'
    )
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(screen.queryByLabelText('Run code')).toBeNull()
  })

  it('switches rendered html cells back to edit mode on Escape', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-html-escape',
      kind: parser_pb.CellKind.CODE,
      languageId: 'html',
      outputs: [],
      metadata: {},
      value: '<div><strong>Hello HTML</strong></div>',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const rendered = screen.getByTestId('html-rendered')
    fireEvent.keyDown(rendered, { key: 'Escape' })

    expect(screen.getByTestId('html-editor')).toBeTruthy()
  })

  it('shows browser/sandbox runner selector for javascript cells', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-runner-select',
      kind: parser_pb.CellKind.CODE,
      languageId: 'javascript',
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: 'console.log("hi")',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const runnerSelect = document.getElementById(
      'runner-select-cell-runner-select'
    )
    const kernelSelect = document.getElementById(
      'kernel-select-cell-runner-select'
    )
    expect(runnerSelect).toBeTruthy()
    expect(kernelSelect).toBeNull()
    const select = runnerSelect as HTMLSelectElement
    expect(select.value).toBe(APPKERNEL_RUNNER_NAME)
    const optionValues = [...select.options].map((option) => option.value)
    expect(optionValues).toEqual([
      APPKERNEL_RUNNER_NAME,
      APPKERNEL_SANDBOX_RUNNER_NAME,
    ])
  })

  it('switches javascript runner to sandbox', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-runner-sandbox',
      kind: parser_pb.CellKind.CODE,
      languageId: 'javascript',
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: 'console.log("hi")',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const runnerSelect = document.getElementById(
      'runner-select-cell-runner-sandbox'
    ) as HTMLSelectElement | null
    expect(runnerSelect).toBeTruthy()
    fireEvent.change(runnerSelect!, {
      target: { value: APPKERNEL_SANDBOX_RUNNER_NAME },
    })

    expect(stub.setRunner).toHaveBeenCalledWith(APPKERNEL_SANDBOX_RUNNER_NAME)
  })

  it('shows runner selector for python cells', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-python-select',
      kind: parser_pb.CellKind.CODE,
      languageId: 'python',
      outputs: [],
      metadata: {},
      value: "print('hi')",
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const runnerSelect = document.getElementById(
      'runner-select-cell-python-select'
    )
    const kernelSelect = document.getElementById(
      'kernel-select-cell-python-select'
    )
    expect(runnerSelect).toBeTruthy()
    expect(kernelSelect).toBeNull()
  })

  it('distinguishes the virtual default choice from the explicit default runner', () => {
    runnerContextMocks.runners = [
      {
        name: 'default',
        endpoint: 'ws://localhost:9977/ws',
        reconnect: true,
        interceptors: [],
      },
      {
        name: 'local',
        endpoint: 'ws://localhost:9988/ws',
        reconnect: true,
        interceptors: [],
      },
      {
        name: 'openai-local',
        endpoint: 'ws://localhost:9988/ws',
        reconnect: true,
        interceptors: [],
      },
    ]
    runnerContextMocks.defaultRunnerName = 'openai-local'
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-runner-default-label',
      kind: parser_pb.CellKind.CODE,
      languageId: 'bash',
      outputs: [],
      metadata: {},
      value: 'echo hello',
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const select = document.getElementById(
      'runner-select-cell-runner-default-label'
    ) as HTMLSelectElement | null
    expect(select).toBeTruthy()
    expect(
      [...select!.options].map((option) => ({
        value: option.value,
        label: option.textContent,
      }))
    ).toEqual([
      { value: '<default>', label: 'default (openai-local)' },
      { value: 'default', label: 'default' },
      { value: 'local', label: 'local' },
      { value: 'openai-local', label: 'openai-local' },
    ])
  })

  it('shows kernel selector (not runner selector) for jupyter cells', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-jupyter-select',
      kind: parser_pb.CellKind.CODE,
      languageId: 'jupyter',
      outputs: [],
      metadata: {},
      value: "print('hi')",
    })
    const stub = new StubCellData(cell)

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />)

    const runnerSelect = document.getElementById(
      'runner-select-cell-jupyter-select'
    )
    const kernelSelect = document.getElementById(
      'kernel-select-cell-jupyter-select'
    )
    expect(runnerSelect).toBeNull()
    expect(kernelSelect).toBeTruthy()
  })

  it('ignores focus on rendered markdown controls that are outside a focus-role surface', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-rendered-controls',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'hello',
    })
    const stub = new StubCellData(cell)
    const onFocusStateChange = vi.fn()

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        onFocusStateChange={onFocusStateChange}
      />
    )

    fireEvent.focus(screen.getByRole('button', { name: 'Delete cell' }))

    expect(onFocusStateChange).not.toHaveBeenCalled()
  })

  it('hides the markdown comment button until hover when the cell has no comments', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-no-comments',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'hello',
    })
    const stub = new StubCellData(cell)

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        commentsAvailable
        commentCount={0}
      />
    )

    const commentButton = screen.getByRole('button', { name: 'Add comment' })
    expect(commentButton.className).toContain('text-nb-accent')
    expect(commentButton.className).toContain('hover:text-nb-accent')
    expect(commentButton.className).toContain('opacity-0')
    expect(commentButton.className).toContain('pointer-events-none')
    expect(commentButton.className).toContain(
      'group-hover/cell:pointer-events-auto'
    )
    expect(commentButton.className).toContain('group-hover/cell:opacity-100')
  })

  it('keeps the markdown comment button visible for the focused cell', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-focused',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'hello',
    })
    const stub = new StubCellData(cell)

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        isActiveCell
        isWindowFocused
        commentsAvailable
        commentCount={0}
      />
    )

    const commentButton = screen.getByRole('button', { name: 'Add comment' })
    expect(commentButton.className).toContain('opacity-100')
    expect(commentButton.className).not.toContain('pointer-events-none')
    expect(commentButton.className).not.toContain('opacity-0')
  })

  it('keeps a disabled markdown comment button visible for the focused cell when comments are unavailable', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-focused-comments-unavailable',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'hello',
    })
    const stub = new StubCellData(cell)

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        isActiveCell
        isWindowFocused
        commentCount={0}
      />
    )

    const commentButton = screen.getByRole('button', {
      name: 'Comments unavailable',
    })
    expect(commentButton).toHaveProperty('disabled', true)
    expect(commentButton.className).toContain('text-nb-text-faint')
    expect(commentButton.className).not.toContain('text-nb-accent')
    expect(commentButton.className).toContain('opacity-100')
    expect(commentButton.className).not.toContain('pointer-events-none')
    expect(commentButton.className).not.toContain('opacity-0')
  })

  it('keeps the markdown comment button visible when the cell has comments', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-with-comments',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'hello',
    })
    const stub = new StubCellData(cell)

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        commentsAvailable
        commentCount={2}
      />
    )

    const commentButton = screen.getByRole('button', {
      name: '2 open comments',
    })
    expect(commentButton.className).toContain('text-nb-accent')
    expect(commentButton.className).toContain('hover:text-nb-accent')
    expect(commentButton.className).toContain('opacity-100')
    expect(commentButton.className).not.toContain('opacity-0')
  })

  it('starts a comment from the markdown cell context menu', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-context-comment',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'hello',
    })
    const stub = new StubCellData(cell)
    const onStartComment = vi.fn()

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        commentsAvailable
        onStartComment={onStartComment}
      />
    )

    fireEvent.contextMenu(screen.getByTestId('markdown-action'))
    const addComment = screen.getByRole('button', { name: 'Add Comment' })
    expect(addComment.dataset.runmeContextMenuAction).toBe('comment-cell')
    const cellMenu = addComment.closest<HTMLElement>('.ctx-menu')
    expect(cellMenu?.dataset.runmeContextMenuCellId).toBe(
      'cell-md-context-comment'
    )
    expect(cellMenu?.dataset.runmeContextMenuKind).toBe('cell')
    fireEvent.click(addComment)

    expect(onStartComment).toHaveBeenCalledWith({
      type: 'cell',
      cellId: 'cell-md-context-comment',
    })
    expect(screen.queryByRole('button', { name: 'Add Comment' })).toBeNull()
  })

  it('starts a rendered-selection comment from the markdown context menu', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-selection-context-comment',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'Read **the [migration guide](https://example.com)** today.',
    })
    const stub = new StubCellData(cell)
    const onStartComment = vi.fn()

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        commentsAvailable
        onStartComment={onStartComment}
      />
    )

    const selectedSpan = screen.getByText('migration guide')
    const range = document.createRange()
    range.setStart(selectedSpan.firstChild!, 0)
    range.setEnd(selectedSpan.firstChild!, 'migration guide'.length)
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({
        bottom: 20,
        height: 10,
        left: 10,
        right: 90,
        top: 10,
        width: 80,
        x: 10,
        y: 10,
        toJSON: () => ({}),
      }),
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    fireEvent.contextMenu(screen.getByTestId('markdown-rendered'), {
      clientX: 40,
      clientY: 20,
    })
    const commentSelection = screen.getByRole('button', {
      name: 'Comment on selected text',
    })
    expect(commentSelection.dataset.runmeContextMenuAction).toBe(
      'comment-selection'
    )
    const selectionMenu = commentSelection.closest<HTMLElement>('.ctx-menu')
    expect(selectionMenu?.dataset.runmeContextMenuCellId).toBe(
      'cell-md-selection-context-comment'
    )
    expect(selectionMenu?.dataset.runmeContextMenuKind).toBe(
      'rendered-selection'
    )
    fireEvent.click(commentSelection)

    expect(onStartComment).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cell-text',
        cellId: 'cell-md-selection-context-comment',
        selectors: [
          { type: 'TextPositionSelector', start: 9, end: 24 },
          expect.objectContaining({
            type: 'TextQuoteSelector',
            exact: 'migration guide',
          }),
        ],
      })
    )
    selection.removeAllRanges()
  })

  it('copies rendered selected text when comments are unavailable', async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-selection-context-copy',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'Copy **this selected text** please.',
    })
    const stub = new StubCellData(cell)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <Action cellData={stub as unknown as CellData} isFirst={false} readOnly />
    )

    const selectedSpan = screen.getByText('this selected text')
    const range = document.createRange()
    range.selectNodeContents(selectedSpan)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    fireEvent.contextMenu(screen.getByTestId('markdown-rendered'), {
      clientX: 40,
      clientY: 20,
    })
    const copySelection = screen.getByRole('button', { name: 'Copy' })
    expect(copySelection.dataset.runmeContextMenuAction).toBe('copy-selection')
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Comment on selected text',
      }).disabled
    ).toBe(true)

    fireEvent.click(copySelection)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('this selected text')
    })
    expect(toastMocks.showToast).toHaveBeenCalledWith({
      message: 'Selected text copied',
      tone: 'success',
    })
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
    selection.removeAllRanges()
  })

  it('keeps the cell comment button independent of a selection menu', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'cell-md-independent-comment',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      outputs: [],
      metadata: {},
      value: 'Select this text.',
    })
    const stub = new StubCellData(cell)
    const onStartComment = vi.fn()

    render(
      <Action
        cellData={stub as unknown as CellData}
        isFirst={false}
        commentsAvailable
        onStartComment={onStartComment}
      />
    )

    const text = screen.getByText('Select this text.').firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 6)
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({
        bottom: 20,
        height: 10,
        left: 10,
        right: 70,
        top: 10,
        width: 60,
        x: 10,
        y: 10,
        toJSON: () => ({}),
      }),
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    fireEvent.contextMenu(screen.getByTestId('markdown-rendered'), {
      clientX: 40,
      clientY: 20,
    })
    expect(
      screen.getByRole('button', { name: 'Comment on selected text' })
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    expect(onStartComment).toHaveBeenCalledWith({
      type: 'cell',
      cellId: 'cell-md-independent-comment',
    })
    selection.removeAllRanges()
  })
})
