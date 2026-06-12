// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { clone, create } from '@bufbuild/protobuf'
import {
  APPKERNEL_RUNNER_NAME,
  APPKERNEL_SANDBOX_RUNNER_NAME,
} from '../../lib/runtime/appKernel'

import { parser_pb, RunmeMetadataKey } from '../../runme/client'
import type { CellData } from '../../lib/notebookData'
import { computeNotebookDiff } from '../../lib/notebookDiff/diff'
import {
  getNotebookDiffDocumentUri,
  registerNotebookDiffDocument,
} from '../../lib/notebookDiff/registry'
import { VERSION_INFO_DOCUMENT_URI } from '../../lib/workspaceDocuments/workspaceDocumentTypes'
import Actions, { Action, ActionOutputItems } from './Actions'

const contextMocks = vi.hoisted(() => ({
  workspaceDocuments: [] as Array<{
    uri: string
    title: string
    state?: 'loading' | 'loaded' | 'blocked' | 'error'
    readOnly?: boolean
  }>,
  currentDoc: null as string | null,
  setCurrentDoc: vi.fn(),
  showDocument: vi.fn(),
  closeWorkspaceDocument: vi.fn(),
  getNotebookData: vi.fn(),
  notebookSnapshots: new Map<
    string,
    { uri: string; loaded: boolean; notebook: parser_pb.Notebook }
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
  },
}))

const conflictMocks = vi.hoisted(() => ({
  openNotebookConflictDiff: vi.fn(async () => undefined),
  refreshNotebookConflictDiff: vi.fn(async () => undefined),
  restoreDeletedConflictCell: vi.fn(async () => undefined),
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
    listRunners: () => [],
    defaultRunnerName: '<default>',
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

vi.mock('../../lib/notebookDiff/conflict', () => ({
  openNotebookConflictDiff: conflictMocks.openNotebookConflictDiff,
  refreshNotebookConflictDiff: conflictMocks.refreshNotebookConflictDiff,
  restoreDeletedConflictCell: conflictMocks.restoreDeletedConflictCell,
}))

vi.mock('../../lib/runtime/jupyterManager', () => ({
  getJupyterManager: () => ({
    subscribe: () => () => {},
    getVersion: () => 0,
    ensureRunnerData: async () => {},
    getKernelOptionsForRunner: () => [],
    getKernelOptionKey: (serverName: string, kernelId: string) =>
      `${serverName}:${kernelId}`,
    parseKernelOptionKey: (key: string) => {
      if (!key.includes(':')) return null
      const [serverName, kernelId] = key.split(':', 2)
      if (!serverName || !kernelId) return null
      return { serverName, kernelId }
    },
  }),
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
  contextMocks.workspaceDocuments = []
  contextMocks.currentDoc = null
  contextMocks.setCurrentDoc.mockReset()
  contextMocks.setCurrentDoc.mockImplementation((uri: string | null) => {
    contextMocks.currentDoc = uri
  })
  contextMocks.showDocument.mockReset()
  contextMocks.closeWorkspaceDocument.mockReset()
  contextMocks.getNotebookData.mockReset()
  contextMocks.getNotebookData.mockReturnValue(null)
  contextMocks.notebookSnapshots.clear()
  contextMocks.notebookStore = null
  conflictMocks.openNotebookConflictDiff.mockReset()
  conflictMocks.openNotebookConflictDiff.mockResolvedValue(undefined)
  conflictMocks.refreshNotebookConflictDiff.mockReset()
  conflictMocks.refreshNotebookConflictDiff.mockResolvedValue(undefined)
})

describe('Actions tabs', () => {
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

  it('marks read-only notebook tabs and content clearly', () => {
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
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {},
        cells: [],
      }),
    })

    render(<Actions />)

    expect(
      screen.getAllByLabelText('Read-only notebook').length
    ).toBeGreaterThan(0)
    expect(
      screen.getByTestId('notebook-readonly-banner').textContent
    ).toContain('Read-only')
    expect(screen.queryByLabelText('Add first cell')).toBeNull()
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

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'restored.json' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown Link' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '[202602a_tb_aws_codex_136](http://localhost:3000/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV%2Fview)'
      )
    })
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
})

describe('Action component', () => {
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
})
