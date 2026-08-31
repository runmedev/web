// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import md5 from 'md5'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import { GoogleClientManager } from '../googleClientManager'
import { driveLinkCoordinator } from '../driveLinkCoordinator'
import { dismissTour, tourGuideStore } from '../tourGuide'
import { tourUiController } from '../tourUiController'
import { appState } from './AppState'
import { createAppJsGlobals } from './appJsGlobals'
import type { NotebookDataLike, RunmeConsoleApi } from './runmeConsole'

vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'never' },
  Excalidraw: () => null,
  restore: (data: any) => ({
    elements: data?.elements ?? [],
    appState: data?.appState ?? {},
    files: data?.files ?? {},
  }),
  serializeAsJSON: (elements: unknown[], appState: unknown, files: unknown) =>
    JSON.stringify({
      type: 'excalidraw',
      elements,
      appState,
      files,
    }),
}))

vi.mock('@excalidraw/excalidraw/index.css', () => ({}))

class FakeNotebookData implements NotebookDataLike {
  private readonly notebook = create(parser_pb.NotebookSchema, { cells: [] })

  constructor(
    private readonly uri: string,
    private readonly name: string
  ) {}

  getUri(): string {
    return this.uri
  }

  getName(): string {
    return this.name
  }

  getNotebook(): parser_pb.Notebook {
    return this.notebook
  }

  updateCell(cell: parser_pb.Cell): void {
    const index = this.notebook.cells.findIndex(
      (candidate) => candidate.refId === cell.refId
    )
    this.notebook.cells[index] = create(parser_pb.CellSchema, cell)
  }

  getCell(): null {
    return null
  }

  appendCell(
    kind = parser_pb.CellKind.CODE,
    languageId?: string | null
  ): parser_pb.Cell {
    const cell = create(parser_pb.CellSchema, {
      refId: `cell-${this.notebook.cells.length + 1}`,
      kind,
      languageId: languageId ?? 'bash',
      metadata: {},
    })
    this.notebook.cells.push(cell)
    return cell
  }

  removeCell(refId: string): void {
    this.notebook.cells = this.notebook.cells.filter(
      (cell) => cell.refId !== refId
    )
  }
}

function createRunme(current: NotebookDataLike | null = null): RunmeConsoleApi {
  return {
    getCurrentNotebook: () => current,
    clear: () => '',
    clearOutputs: () => '',
    runAll: () => '',
    rerun: () => '',
    help: () => '',
  }
}

describe('createAppJsGlobals notebook reference helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    appState.setDriveNotebookStore(null)
    appState.setLocalNotebooks(null)
    appState.setOpenNotebookHandler(null)
    appState.setLoadNotebookHandler(null)
    appState.setFocusNotebookHandler(null)
    appState.setGoogleDriveOAuthHandler(null)
    appState.setWorkspaceRenameHandler(null)
    window.localStorage.clear()
    ;(
      GoogleClientManager as unknown as {
        singleton: GoogleClientManager | null
      }
    ).singleton = null
    delete (window as any).showOpenFilePicker
    window.history.replaceState(null, '', '/')
    dismissTour()
    tourUiController.resetForTests()
  })

  it('resolves a local URI to metadata, share URL, and Markdown link', async () => {
    window.history.replaceState(null, '', '/workspace?ignored=true')
    appState.setLocalNotebooks({
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/local-id',
        name: 'Team Notes.json',
        type: 'file',
        children: [],
        remoteUri: 'https://drive.google.com/file/d/file123/view',
        parents: [],
      })),
      files: {
        where: vi.fn(),
      },
    } as any)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    const info = await globals.notebooks.resolve('local://file/local-id')

    expect(info).toMatchObject({
      uri: 'local://file/local-id',
      localUri: 'local://file/local-id',
      remoteUri: 'https://drive.google.com/file/d/file123/view',
      googleDriveUrl: 'https://drive.google.com/file/d/file123/view',
      title: 'Team Notes.json',
      shareTarget: 'https://drive.google.com/file/d/file123/view',
      source: 'drive',
    })
    expect(info.shareUrl).toBe(
      'http://localhost:3000/workspace?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Ffile123%2Fview'
    )
    expect(info.markdownLink).toBe(
      '[Team Notes](http://localhost:3000/workspace?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Ffile123%2Fview)'
    )
  })

  it('exposes the shared tour guide runtime', async () => {
    const globals = createAppJsGlobals({ runme: createRunme() })

    expect(globals.tour.listTargets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'left-nav.google-drive' }),
      ])
    )
    expect(globals.tour.getUiSnapshot()).toMatchObject({
      revision: expect.any(Number),
      googleDriveAuthorized: expect.any(Boolean),
      googleDriveFolderAddedCount: expect.any(Number),
    })
    globals.tour.show({
      target: 'left-nav.google-drive',
      message: 'Connect Google Drive here.',
    })
    expect(tourGuideStore.getSnapshot()).toMatchObject({
      target: 'left-nav.google-drive',
      message: 'Connect Google Drive here.',
    })
    expect(globals.tour.dismiss()).toBe(true)
    expect(globals.tour.help()).toContain('Timed tour example')
    expect(globals.tour.help()).toContain('tour.getUiSnapshot()')
    expect(globals.tour.help()).toContain('tour.waitForUiChange')
    expect(globals.tour.help()).toContain('setTimeout(resolve, delayMs)')
    expect(globals.tour.help()).toContain('finally')
    expect(globals.tour.help()).toContain(
      'replaces the active highlight; no intermediate dismiss is needed'
    )

    const before = globals.tour.getUiSnapshot()
    const waiting = globals.tour.waitForUiChange({
      afterRevision: before.revision,
      timeoutMs: 1_000,
    })
    globals.tour.setActivePanel(
      before.activePanel === 'explorer' ? null : 'explorer'
    )
    await expect(waiting).resolves.toMatchObject({ timedOut: false })
  })

  it('opens a local URI from a Runme share URL without changing focus', async () => {
    const opened = vi.fn(async (uri: string) => uri)
    const focused = vi.fn()
    const globals = createAppJsGlobals({
      runme: createRunme(),
      openNotebook: opened,
      focusNotebook: focused,
    })

    const info = await globals.notebooks.open(
      'https://runme.example/?doc=local%3A%2F%2Ffile%2Fopened'
    )

    expect(opened).toHaveBeenCalledWith('local://file/opened')
    expect(focused).not.toHaveBeenCalled()
    expect(info.opened).toBe('local://file/opened')
  })

  it('returns the imported local URI after opening a Drive reference', async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'local://file/imported',
        name: 'Eval Write.json',
      })
    appState.setLocalNotebooks({
      files: {
        where: vi.fn(() => ({
          equals: vi.fn(() => ({ first })),
        })),
      },
    } as any)
    const enqueue = vi
      .spyOn(driveLinkCoordinator, 'enqueue')
      .mockResolvedValue(undefined)
    const focused = vi.fn()
    const globals = createAppJsGlobals({
      runme: createRunme(),
      focusNotebook: focused,
    })
    const remoteUri =
      'https://drive.google.com/file/d/1iTN_c0h93BQS0WnAJiAT88JZHhhmnNRI/view'

    const info = await globals.notebooks.open(remoteUri)

    expect(enqueue).toHaveBeenCalledWith(remoteUri, 'manual', { focus: false })
    expect(focused).not.toHaveBeenCalled()
    expect(info).toMatchObject({
      localUri: 'local://file/imported',
      opened: 'local://file/imported',
      remoteUri,
    })
  })

  it('focuses an imported Drive reference when showing it', async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'local://file/imported',
        name: 'Eval Write.json',
      })
    appState.setLocalNotebooks({
      files: {
        where: vi.fn(() => ({
          equals: vi.fn(() => ({ first })),
        })),
      },
    } as any)
    vi.spyOn(driveLinkCoordinator, 'enqueue').mockResolvedValue(undefined)
    const focused = vi.fn()
    const globals = createAppJsGlobals({
      runme: createRunme(),
      focusNotebook: focused,
    })
    const remoteUri =
      'https://drive.google.com/file/d/1iTN_c0h93BQS0WnAJiAT88JZHhhmnNRI/view'

    const info = await globals.notebooks.show(remoteUri)

    expect(focused).toHaveBeenCalledWith('local://file/imported')
    expect(info).toMatchObject({
      opened: 'local://file/imported',
      focused: 'local://file/imported',
    })
  })

  it('focuses an already-open notebook separately from opening it', async () => {
    const opened = vi.fn(async (uri: string) => uri)
    const focused = vi.fn()
    const globals = createAppJsGlobals({
      runme: createRunme(),
      openNotebook: opened,
      focusNotebook: focused,
    })

    const info = await globals.notebooks.focus('local://file/opened')

    expect(opened).not.toHaveBeenCalled()
    expect(focused).toHaveBeenCalledWith('local://file/opened')
    expect(info.focused).toBe('local://file/opened')
  })

  it('keeps notebooks.show as an open-and-focus compatibility helper', async () => {
    const opened = vi.fn(async (uri: string) => uri)
    const focused = vi.fn()
    const globals = createAppJsGlobals({
      runme: createRunme(),
      openNotebook: opened,
      focusNotebook: focused,
    })

    const info = await globals.notebooks.show('local://file/opened')

    expect(opened).toHaveBeenCalledWith('local://file/opened')
    expect(focused).toHaveBeenCalledWith('local://file/opened')
    expect(info).toMatchObject({
      opened: 'local://file/opened',
      focused: 'local://file/opened',
    })
  })

  it('uses the current notebook when no reference is passed', async () => {
    window.history.replaceState(null, '', '/')
    const globals = createAppJsGlobals({
      runme: createRunme(
        new FakeNotebookData('local://file/current', 'Current')
      ),
    })

    await expect(globals.notebooks.shareUrl()).resolves.toBe(
      'http://localhost:3000/?doc=local%3A%2F%2Ffile%2Fcurrent'
    )
  })

  it('exposes the shared image embed helper at the top level and on notebooks', async () => {
    const notebook = new FakeNotebookData(
      'local://file/current',
      'Current.json'
    )
    const sendOutput = vi.fn()
    const globals = createAppJsGlobals({
      runme: createRunme(notebook),
      sendOutput,
    })

    const result = await globals.embed(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      { name: 'screenshot.png' }
    )

    expect(result.cell.languageId).toBe('html')
    expect(notebook.getNotebook().cells[0]?.value).toContain(
      'data:image/png;base64,AQID'
    )
    expect(globals.notebooks.embed).toBe(globals.embed)
    await expect(globals.notebooks.help('embed')).resolves.toContain(
      'notebooks.embed'
    )
    expect(sendOutput).toHaveBeenCalledWith(
      'Embedded image screenshot.png.\r\n'
    )
  })

  it('attaches linked resources through the shared notebooks API', async () => {
    const notebook = new FakeNotebookData(
      'local://file/current',
      'Current.json'
    )
    const sendOutput = vi.fn()
    const globals = createAppJsGlobals({
      runme: createRunme(notebook),
      resolveNotebook: () => notebook,
      sendOutput,
    })

    const result = await globals.notebooks.attach(
      { kind: 'url', uri: 'https://example.com/demo.webm' },
      {
        target: { uri: notebook.getUri() },
        mode: 'video',
        title: 'Demo video',
      }
    )

    expect(result.cell.languageId).toBe('runme-resource')
    expect(result.resource).toMatchObject({
      source: {
        provider: 'https',
        uri: 'https://example.com/demo.webm',
      },
      presentation: { mode: 'video', title: 'Demo video' },
    })
    expect(notebook.getNotebook().cells).toHaveLength(1)
    await expect(globals.notebooks.help('attach')).resolves.toContain(
      'notebooks.attach'
    )
    expect(sendOutput).toHaveBeenCalledWith(
      'Attached resource https://example.com/demo.webm.\r\n'
    )
  })

  it('exposes notebook write access requests through the App Console globals', async () => {
    const notebook = new FakeNotebookData(
      'local://file/current',
      'Current.json'
    )
    const requestNotebookWriteAccess = vi.fn(async () => undefined)
    const globals = createAppJsGlobals({
      runme: createRunme(notebook),
      requestNotebookWriteAccess,
    })

    const document = await globals.notebooks.requestWriteAccess({
      target: { uri: notebook.getUri() },
    })

    expect(requestNotebookWriteAccess).toHaveBeenCalledWith(notebook.getUri())
    expect(document.summary.uri).toBe(notebook.getUri())
    await expect(
      globals.notebooks.help('requestWriteAccess')
    ).resolves.toContain('notebooks.requestWriteAccess({ target })')
  })

  it('resolves object image targets to the requested notebook URI', async () => {
    const current = new FakeNotebookData('local://file/current', 'Current.json')
    const requested = new FakeNotebookData(
      'local://file/requested',
      'Requested.json'
    )
    const resolveNotebook = vi.fn((target?: unknown) =>
      target === requested.getUri() ? requested : current
    )
    const globals = createAppJsGlobals({
      runme: createRunme(current),
      resolveNotebook,
    })

    await globals.notebooks.embed(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      {
        target: {
          handle: {
            uri: requested.getUri(),
            revision: 'requested-revision',
          },
        },
        name: 'requested.png',
      }
    )

    expect(resolveNotebook).toHaveBeenCalledWith(requested.getUri())
    expect(current.getNotebook().cells).toHaveLength(0)
    expect(requested.getNotebook().cells).toHaveLength(1)
  })

  it('opens inline workspace rename from the explorer runtime API', () => {
    const startRename = vi.fn()
    appState.setWorkspaceRenameHandler(startRename)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    const result = globals.explorer.editName('local://folder/drive')

    expect(result).toBe('Editing name: local://folder/drive')
    expect(startRename).toHaveBeenCalledWith('local://folder/drive')
  })

  it('renames a local workspace folder from the explorer runtime API', async () => {
    const localStore = {
      rename: vi.fn(async (uri: string, name: string) => ({
        uri,
        name,
        type: 'folder',
        children: [],
      })),
    }
    appState.setLocalNotebooks(localStore as any)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    const result = await globals.explorer.renameFolder(
      'local://folder/drive',
      'Renamed Folder'
    )

    expect(localStore.rename).toHaveBeenCalledWith(
      'local://folder/drive',
      'Renamed Folder'
    )
    expect(result).toMatchObject({
      uri: 'local://folder/drive',
      name: 'Renamed Folder',
    })
  })

  it('reads raw document content from the local mirror', async () => {
    const localStore = {
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/diagram',
        name: 'test4.excalidraw',
        type: 'file',
        mimeType: 'application/vnd.excalidraw+json',
        children: [],
        remoteUri: undefined,
        parents: [],
      })),
      files: {
        get: vi.fn(async () => ({
          id: 'local://file/diagram',
          name: 'test4.excalidraw',
          mimeType: 'application/vnd.excalidraw+json',
          remoteId: 'local://file/diagram',
          doc: '{"type":"excalidraw"}',
          md5Checksum: 'local-checksum',
        })),
      },
      loadContent: vi.fn(async () => '{"type":"excalidraw"}'),
      getSyncState: vi.fn(async () => ({
        status: 'local-only',
        localUri: 'local://file/diagram',
        remoteId: 'local://file/diagram',
      })),
    }
    appState.setLocalNotebooks(localStore as any)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    const doc = await globals.documents.get('local://file/diagram')

    expect(localStore.loadContent).toHaveBeenCalledWith('local://file/diagram')
    expect(doc).toMatchObject({
      uri: 'local://file/diagram',
      name: 'test4.excalidraw',
      mimeType: 'application/vnd.excalidraw+json',
      content: '{"type":"excalidraw"}',
      syncStatus: 'local-only',
      version: {
        checksum: 'local-checksum',
      },
    })
  })

  it('lists commit-pinned documentation and fetches remote Markdown', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '# Getting Started',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    const [gettingStarted] = globals.documents.list()
    expect(gettingStarted).toMatchObject({
      title: 'Getting Started',
      readOnly: true,
    })
    expect(gettingStarted.uri).toContain(
      'https://github.com/runmedev/web/blob/'
    )

    const document = await globals.documents.get(gettingStarted.uri)

    expect(fetchMock).toHaveBeenCalledWith(
      gettingStarted.rawUri,
      expect.any(Object)
    )
    expect(document).toMatchObject({
      uri: gettingStarted.uri,
      mimeType: 'text/markdown',
      content: '# Getting Started',
      readOnly: true,
    })

    expect(globals.documentation.list()[0]).toEqual({
      name: 'getting-started',
      description:
        'Use this guide when opening Runme for the first time or when an agent needs the shortest path from an unopened notebook to a successful cell execution. It covers prerequisites, opening a notebook, selecting an execution path, running a cell, and checking its output. For detailed runner configuration, use one of the runner-specific guides.',
    })
    await expect(globals.documentation.get('getting-started')).resolves.toBe(
      '# Getting Started'
    )
    expect(globals.documentation.help()).toContain(
      'await documentation.get(name)'
    )
    expect(globals.documentation.help()).toContain('await documentation.list()')
  })

  it('updates raw document content in the local mirror', async () => {
    const localStore = {
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/diagram',
        name: 'test4.excalidraw',
        type: 'file',
        mimeType: 'application/vnd.excalidraw+json',
        children: [],
        remoteUri: undefined,
        parents: [],
      })),
      files: {
        get: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'local://file/diagram',
            name: 'test4.excalidraw',
            mimeType: 'application/vnd.excalidraw+json',
            remoteId: 'local://file/diagram',
            doc: '{"type":"excalidraw"}',
            md5Checksum: 'before',
          })
          .mockResolvedValueOnce({
            id: 'local://file/diagram',
            name: 'test4.excalidraw',
            mimeType: 'application/vnd.excalidraw+json',
            remoteId: 'local://file/diagram',
            doc: '{"type":"excalidraw","elements":[]}',
            md5Checksum: 'after',
          }),
      },
      loadContent: vi.fn(async () => '{"type":"excalidraw"}'),
      getSyncState: vi.fn(async () => ({
        status: 'local-only',
        localUri: 'local://file/diagram',
        remoteId: 'local://file/diagram',
      })),
      saveContent: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
    }
    appState.setLocalNotebooks(localStore as any)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    const result = await globals.documents.update(
      'local://file/diagram',
      '{"type":"excalidraw","elements":[]}',
      {
        mimeType: 'application/vnd.excalidraw+json',
        expectedVersion: 'before',
        flush: true,
      }
    )

    expect(localStore.saveContent).toHaveBeenCalledWith(
      'local://file/diagram',
      '{"type":"excalidraw","elements":[]}',
      'application/vnd.excalidraw+json'
    )
    expect(localStore.sync).toHaveBeenCalledWith('local://file/diagram')
    expect(result).toMatchObject({
      uri: 'local://file/diagram',
      name: 'test4.excalidraw',
      syncStatus: 'local-only',
      version: {
        checksum: 'after',
      },
    })
    expect(result).not.toHaveProperty('content')
  })

  it('rejects raw document updates when the expected version does not match', async () => {
    const localStore = {
      getMetadata: vi.fn(async () => ({
        uri: 'local://file/diagram',
        name: 'test4.excalidraw',
        type: 'file',
        mimeType: 'application/vnd.excalidraw+json',
        children: [],
        remoteUri: undefined,
        parents: [],
      })),
      files: {
        get: vi.fn(async () => ({
          id: 'local://file/diagram',
          name: 'test4.excalidraw',
          mimeType: 'application/vnd.excalidraw+json',
          remoteId: 'local://file/diagram',
          doc: '{"type":"excalidraw"}',
          md5Checksum: 'actual',
        })),
      },
      loadContent: vi.fn(async () => '{"type":"excalidraw"}'),
      getSyncState: vi.fn(async () => ({
        status: 'local-only',
        localUri: 'local://file/diagram',
        remoteId: 'local://file/diagram',
      })),
      saveContent: vi.fn(async () => undefined),
    }
    appState.setLocalNotebooks(localStore as any)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    await expect(
      globals.documents.update('local://file/diagram', '{}', {
        expectedVersion: 'stale',
      })
    ).rejects.toThrow('Document version mismatch')
    expect(localStore.saveContent).not.toHaveBeenCalled()
  })

  it('starts Google Drive OAuth from runtime globals without returning raw tokens', async () => {
    const startOAuth = vi.fn(async () => ({
      status: 'authorized' as const,
      authFlow: 'implicit' as const,
      mode: 'popup' as const,
      accessToken: 'secret-token',
    }))
    const output: string[] = []
    appState.setGoogleDriveOAuthHandler(startOAuth)
    const globals = createAppJsGlobals({
      runme: createRunme(),
      sendOutput: (data) => output.push(data),
    })

    const result = await globals.drive.authorize({
      mode: 'popup',
      prompt: 'consent',
    })

    expect(startOAuth).toHaveBeenCalledWith({
      mode: 'popup',
      prompt: 'consent',
    })
    expect(result).toEqual({
      status: 'authorized',
      authFlow: 'implicit',
      mode: 'popup',
      accessToken: '<redacted>',
    })
    expect(output.join('')).toContain('Google Drive OAuth authorized.')
  })

  it('searches Google Drive with native files.list parameters', async () => {
    const request = {
      q: "name = 'eval_read.json' and trashed = false",
      orderBy: 'modifiedTime desc',
      fields: 'nextPageToken,files(id,name,mimeType)',
    }
    const search = vi.fn(async () => ({
      files: [
        {
          id: 'file123',
          name: 'eval_read.json',
          mimeType: 'application/json',
          uri: 'https://drive.google.com/file/d/file123/view',
        },
      ],
      nextPageToken: 'page-2',
    }))
    const output: string[] = []
    appState.setDriveNotebookStore({ search } as any)
    const globals = createAppJsGlobals({
      runme: createRunme(),
      sendOutput: (data) => output.push(data),
    })

    const result = await globals.drive.search(request)

    expect(search).toHaveBeenCalledWith(request)
    expect(result.nextPageToken).toBe('page-2')
    expect(result.files[0]?.uri).toBe(
      'https://drive.google.com/file/d/file123/view'
    )
    expect(output.join('')).toContain('Found 1 Drive item(s)')
  })

  it('creates and opens one Drive-backed notebook without a local-only source', async () => {
    let uploadedContent = ''
    const createContent = vi.fn(async (_folder, _name, content) => {
      uploadedContent = content
      return {
        uri: 'https://drive.google.com/file/d/file123/view',
        name: 'new.ipynb',
      }
    })
    const getVersionMetadata = vi.fn(async () => ({
      md5Checksum: md5(uploadedContent),
      headRevisionId: 'drive-revision-1',
    }))
    const addFile = vi.fn(async () => 'local://file/drive-mirror')
    const initializeUploadedDriveNotebook = vi.fn(async () => true)
    const openNotebook = vi.fn(async () => undefined)
    const output: string[] = []
    appState.setDriveNotebookStore({
      createContent,
      getVersionMetadata,
    } as any)
    appState.setLocalNotebooks({
      addFile,
      initializeUploadedDriveNotebook,
    } as any)
    appState.setOpenNotebookHandler(openNotebook)
    const globals = createAppJsGlobals({
      runme: createRunme(),
      sendOutput: (data) => output.push(data),
    })

    const result = await globals.drive.createNotebook(
      'folder123',
      'new.ipynb',
      {
        cells: [{ kind: 'markup', value: '# New notebook' }],
      }
    )

    expect(result).toMatchObject({
      fileId: 'file123',
      remoteUri: 'https://drive.google.com/file/d/file123/view',
      localUri: 'local://file/drive-mirror',
    })
    expect(addFile).toHaveBeenCalledTimes(1)
    expect(initializeUploadedDriveNotebook).toHaveBeenCalledWith(
      result.localUri,
      expect.objectContaining({
        cells: [expect.objectContaining({ value: '# New notebook' })],
      }),
      expect.any(String),
      {
        checksum: md5(uploadedContent),
        revisionId: 'drive-revision-1',
      }
    )
    expect(openNotebook).toHaveBeenCalledWith(result.localUri)
    expect(output.join('')).toContain('Created Drive-backed notebook')
  })

  it('moves Google Drive files to trash from browser AppKernel drive globals', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const moveToTrash = vi.fn(async () => ({
      uri: remoteUri,
      name: 'untitled.json',
      type: 'file',
      children: [],
      remoteUri,
      parents: [],
    }))
    const output: string[] = []
    appState.setDriveNotebookStore({
      moveToTrash,
    } as any)
    const globals = createAppJsGlobals({
      runme: createRunme(),
      sendOutput: (data) => output.push(data),
    })

    const result = await globals.drive.trash(remoteUri)

    expect(moveToTrash).toHaveBeenCalledWith(remoteUri)
    expect(result).toMatchObject({
      uri: remoteUri,
      name: 'untitled.json',
      remoteUri,
    })
    expect(output.join('')).toContain(
      'Moved Drive file to trash: untitled.json'
    )
  })

  it('exposes Drive comments through the shared AppKernel globals', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const notebook = new FakeNotebookData(remoteUri, 'review.ipynb')
    const cell = notebook.appendCell(parser_pb.CellKind.MARKUP, 'markdown')
    cell.value = 'Review this paragraph.'
    notebook.updateCell(cell)
    const listComments = vi.fn(async () => [
      {
        id: 'comment-1',
        content: 'Clarify this.',
        resolved: false,
        anchor: JSON.stringify({
          runme: { version: 2, type: 'cell', cellId: cell.refId },
        }),
      },
    ])
    appState.setDriveNotebookStore({ listComments } as any)
    const globals = createAppJsGlobals({
      runme: createRunme(notebook),
      resolveNotebook: () => notebook,
    })

    const annotations = await globals.comments.list()

    expect(listComments).toHaveBeenCalledWith(remoteUri)
    expect(annotations).toEqual([
      expect.objectContaining({
        id: 'comment-1',
        content: 'Clarify this.',
        editableSource: expect.objectContaining({
          cellId: cell.refId,
          content: 'Review this paragraph.',
        }),
        currentResolution: { status: 'cell' },
      }),
    ])
  })

  it('loads Google service account credentials from a picked local JSON file', async () => {
    const sendOutput = vi.fn()
    const ensureAccessToken = vi.fn(async () => 'service-account-token')
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      client_email: 'runme-drive-test@example.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
      private_key_id: 'key-id',
      token_uri: 'https://oauth2.googleapis.com/token',
    })
    ;(window as any).showOpenFilePicker = vi.fn(async () => [
      {
        getFile: async () => ({
          name: 'service-account.json',
          text: async () => serviceAccountJson,
        }),
      },
    ])

    const globals = createAppJsGlobals({
      runme: createRunme(),
      sendOutput,
      ensureAccessToken,
    })

    const config = await globals.credentials.google.setServiceAccountFromFile()

    expect(config).toMatchObject({
      authFlow: 'service_account',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
        privateKeyId: 'key-id',
        tokenUri: 'https://oauth2.googleapis.com/token',
      },
    })
    expect(globals.googleClientManager.get()).toMatchObject({
      authFlow: 'service_account',
    })
    expect(ensureAccessToken).toHaveBeenCalledWith({
      interactive: false,
      forceRefresh: true,
    })
    expect(sendOutput).toHaveBeenCalledWith(
      'Loaded Google Drive service account credentials from service-account.json.\r\n'
    )
  })

  it('loads Google service account credentials from a local dev-server path', async () => {
    const sendOutput = vi.fn()
    const keyPath = '/Users/jlewi/secrets/service-account.json'
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      client_email: 'runme-drive-test@example.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
      private_key_id: 'key-id',
      token_uri: 'https://oauth2.googleapis.com/token',
    })
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/__runme-dev/service-account-key')
      expect(url).toContain(
        'path=%2FUsers%2Fjlewi%2Fsecrets%2Fservice-account.json'
      )
      return new Response(
        JSON.stringify({
          name: 'service-account.json',
          path: keyPath,
          text: serviceAccountJson,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const ensureAccessToken = vi.fn(async () => 'service-account-token')

    const globals = createAppJsGlobals({
      runme: createRunme(),
      sendOutput,
      ensureAccessToken,
    })

    const config =
      await globals.credentials.google.setServiceAccountFromFilePath(keyPath)

    expect(config).toMatchObject({
      authFlow: 'service_account',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
        privateKeyId: 'key-id',
        tokenUri: 'https://oauth2.googleapis.com/token',
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ensureAccessToken).toHaveBeenCalledWith({
      interactive: false,
      forceRefresh: true,
    })
    expect(sendOutput).toHaveBeenCalledWith(
      `Loaded Google Drive service account credentials from ${keyPath}.\r\n`
    )
  })
})
