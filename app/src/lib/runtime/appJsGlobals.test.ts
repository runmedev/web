// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import { GoogleClientManager } from '../googleClientManager'
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
    vi.unstubAllGlobals()
    appState.setDriveNotebookStore(null)
    appState.setLocalNotebooks(null)
    appState.setOpenNotebookHandler(null)
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

  it('opens a local URI from a Runme share URL', async () => {
    const opened = vi.fn()
    appState.setOpenNotebookHandler(opened)
    const globals = createAppJsGlobals({
      runme: createRunme(),
    })

    const info = await globals.notebooks.show(
      'https://runme.example/?doc=local%3A%2F%2Ffile%2Fopened'
    )

    expect(opened).toHaveBeenCalledWith('local://file/opened')
    expect(info.opened).toBe('local://file/opened')
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

  it('loads Google service account credentials from a picked local JSON file', async () => {
    const sendOutput = vi.fn()
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
    expect(ensureAccessToken).toHaveBeenCalledWith({ interactive: false })
    expect(sendOutput).toHaveBeenCalledWith(
      `Loaded Google Drive service account credentials from ${keyPath}.\r\n`
    )
  })
})
