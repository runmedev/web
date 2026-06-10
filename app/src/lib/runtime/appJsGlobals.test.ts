// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
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
    appState.setLocalNotebooks(null)
    appState.setOpenNotebookHandler(null)
    appState.setGoogleDriveOAuthHandler(null)
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
})
