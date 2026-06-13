// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import { GoogleClientManager } from '../googleClientManager'
import { appState } from './AppState'
import { createAppJsGlobals } from './appJsGlobals'
import type { NotebookDataLike, RunmeConsoleApi } from './runmeConsole'

class FakeNotebookData implements NotebookDataLike {
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
    return create(parser_pb.NotebookSchema, { cells: [] })
  }

  updateCell(): void {}

  getCell(): null {
    return null
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
    appState.setLocalNotebooks(null)
    appState.setOpenNotebookHandler(null)
    appState.setGoogleDriveOAuthHandler(null)
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
