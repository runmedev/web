// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { NotebookUpdateError } from './runmeConsole'
import {
  CODE_MODE_SANDBOX_ALLOWED_METHODS,
  SandboxJSKernel,
  buildSandboxSrcDoc,
} from './sandboxJsKernel'

type Scenario =
  | 'success'
  | 'disallowed'
  | 'hang'
  | 'lowLevel'
  | 'app'
  | 'ui'
  | 'tour'
  | 'explorer'
  | 'credentials'
  | 'drive'
  | 'driveSearch'
  | 'driveSave'
  | 'documents'
  | 'documentation'
  | 'comments'
  | 'notebooksCreate'
  | 'notebooksEmbed'
  | 'notebooksWriteAccess'
  | 'notebooksUpdateError'

class MockSandboxPort {
  onmessage: ((event: MessageEvent<any>) => void) | null = null
  readonly sentFromHost: Array<Record<string, unknown>> = []
  private readonly hostResults = new Map<number, unknown>()

  constructor(private readonly scenario: Scenario) {}

  postMessage(message: Record<string, unknown>) {
    this.sentFromHost.push(message)
    const type = String(message.type ?? '')

    if (type === 'run') {
      if (this.scenario === 'success') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'runme.getCurrentNotebook',
          args: [],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'runme.clear',
          args: [undefined],
        })
      } else if (this.scenario === 'lowLevel') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'opfs.readText',
          args: ['/code/runmedev/web.txt'],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'net.get',
          args: ['https://example.test/docs'],
        })
      } else if (this.scenario === 'app') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'app.getSessionID',
          args: [],
        })
      } else if (this.scenario === 'ui') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'ui.prepareRenderedComment',
          args: [
            {
              target: { uri: 'local://fixture.ipynb' },
              cellId: 'cell-1',
              selector: { type: 'TextQuoteSelector', exact: 'guide' },
            },
          ],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'ui.clearSelection',
          args: [],
        })
      } else if (this.scenario === 'tour') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'tour.listTargets',
          args: [],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'tour.getUiSnapshot',
          args: [],
        })
        this.emit({
          type: 'host-call',
          callId: 3,
          method: 'tour.waitForUiChange',
          args: [{ afterRevision: 2, timeoutMs: 1_000 }],
        })
        this.emit({
          type: 'host-call',
          callId: 4,
          method: 'tour.setActivePanel',
          args: ['explorer'],
        })
        this.emit({
          type: 'host-call',
          callId: 5,
          method: 'tour.show',
          args: [
            {
              target: 'left-nav.google-drive',
              message: 'Sign in here.',
            },
          ],
        })
      } else if (this.scenario === 'explorer') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'explorer.renameFolder',
          args: ['local://folder/drive', 'Renamed Folder'],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'explorer.editName',
          args: ['local://folder/drive'],
        })
      } else if (this.scenario === 'credentials') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'credentials.google.setServiceAccountFromFilePath',
          args: ['/tmp/service-account.json'],
        })
      } else if (this.scenario === 'drive') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'drive.authorize',
          args: [{ mode: 'new_tab' }],
        })
      } else if (this.scenario === 'driveSearch') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'drive.search',
          args: [
            {
              q: "name = 'eval_read.json' and trashed = false",
              pageSize: 25,
            },
          ],
        })
      } else if (this.scenario === 'driveSave') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'drive.saveAsCurrentNotebook',
          args: ['root', 'Comments demo.ipynb'],
        })
      } else if (this.scenario === 'documents') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'documents.list',
          args: [],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'documents.get',
          args: ['local://file/test4'],
        })
        this.emit({
          type: 'host-call',
          callId: 3,
          method: 'documents.update',
          args: [
            'local://file/test4',
            '{"type":"excalidraw","elements":[{"id":"label","type":"text","text":"Box A"}]}',
            { mimeType: 'application/vnd.excalidraw+json' },
          ],
        })
      } else if (this.scenario === 'documentation') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'documentation.list',
          args: [],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'documentation.get',
          args: ['getting-started'],
        })
      } else if (this.scenario === 'comments') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'comments.list',
          args: [
            {
              target: { uri: 'local://file/test' },
              status: 'open',
            },
          ],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'comments.resolve',
          args: [
            {
              target: { uri: 'local://file/test' },
              commentId: 'comment-1',
            },
          ],
        })
      } else if (this.scenario === 'notebooksCreate') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'notebooks.createLocal',
          args: ['Comments demo.ipynb', undefined],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'notebooks.appendCell',
          args: [
            {
              target: {
                handle: { uri: 'local://file/comments-demo', revision: '1' },
              },
              kind: 'markup',
              value: '# Comments demo',
            },
          ],
        })
      } else if (this.scenario === 'notebooksEmbed') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'embed',
          args: ['/tmp/screenshot.png', { alt: 'Screenshot' }],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'notebooks.embed',
          args: ['data:image/png;base64,AQID', undefined],
        })
      } else if (this.scenario === 'notebooksWriteAccess') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'notebooks.requestWriteAccess',
          args: [{ target: { uri: 'local://file/demo' } }],
        })
      } else if (this.scenario === 'notebooksUpdateError') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'notebooks.update',
          args: [
            {
              target: { uri: 'local://file/demo' },
              operations: [],
            },
          ],
        })
      } else if (this.scenario === 'hang') {
        this.emit({ type: 'stdout', data: 'started\n' })
      } else {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'runme.clear',
          args: [undefined],
        })
      }
      return
    }

    if (type === 'host-result') {
      const callId = Number(message.callId ?? 0)
      this.hostResults.set(callId, message.result)
      if (this.scenario === 'app' && this.hostResults.has(1)) {
        this.emit({
          type: 'stdout',
          data: `${String(this.hostResults.get(1) ?? '')}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'ui' && this.hostResults.has(2)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(2) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (
        this.scenario === 'tour' &&
        this.hostResults.has(1) &&
        this.hostResults.has(2)
      ) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(2) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'drive' && this.hostResults.has(1)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'driveSearch' && this.hostResults.has(1)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'driveSave' && this.hostResults.has(1)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'explorer' && this.hostResults.has(2)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({
          type: 'stdout',
          data: `${String(this.hostResults.get(2) ?? '')}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'documents' && this.hostResults.has(2)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(2) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'documentation' && this.hostResults.has(2)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({
          type: 'stdout',
          data: `${String(this.hostResults.get(2) ?? '')}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'comments' && this.hostResults.has(2)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(2) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (
        this.scenario === 'notebooksCreate' &&
        this.hostResults.has(1) &&
        this.hostResults.has(2)
      ) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(2) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (
        this.scenario === 'notebooksEmbed' &&
        this.hostResults.has(1) &&
        this.hostResults.has(2)
      ) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(2) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'notebooksWriteAccess' && this.hostResults.has(1)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'credentials' && this.hostResults.has(1)) {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(this.hostResults.get(1) ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }

      if (this.hostResults.has(1) && this.hostResults.has(2)) {
        if (this.scenario === 'success') {
          const notebookInfo = this.hostResults.get(1) as
            | { name?: string; cellCount?: number }
            | undefined
          this.emit({ type: 'stdout', data: `${notebookInfo?.name ?? ''}\n` })
          this.emit({
            type: 'stdout',
            data: `${notebookInfo?.cellCount ?? ''}\n`,
          })
          this.emit({
            type: 'stdout',
            data: `${String(this.hostResults.get(2) ?? '')}\n`,
          })
          this.emit({ type: 'exit', exitCode: 0 })
        } else if (this.scenario === 'lowLevel') {
          this.emit({
            type: 'stdout',
            data: `${String(this.hostResults.get(1) ?? '')}\n`,
          })
          this.emit({
            type: 'stdout',
            data: `${JSON.stringify(this.hostResults.get(2) ?? null)}\n`,
          })
          this.emit({ type: 'exit', exitCode: 0 })
        }
      }
      return
    }

    if (type === 'host-error') {
      if (this.scenario === 'notebooksUpdateError') {
        this.emit({
          type: 'stdout',
          data: `${JSON.stringify(message.error ?? null)}\n`,
        })
        this.emit({ type: 'exit', exitCode: 0 })
        return
      }
      if (this.scenario === 'disallowed' || this.scenario === 'lowLevel') {
        this.emit({ type: 'stderr', data: String(message.error ?? '') + '\n' })
        this.emit({ type: 'exit', exitCode: 1 })
      }
    }
  }

  start() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}

  private emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
}

class TestableSandboxJSKernel extends SandboxJSKernel {
  constructor(
    private readonly port: MockSandboxPort,
    options: ConstructorParameters<typeof SandboxJSKernel>[0],
    private readonly disposeSession = () => {}
  ) {
    super(options)
  }

  protected override async createSession(): Promise<any> {
    return {
      iframe: {} as HTMLIFrameElement,
      port: this.port as unknown as MessagePort,
      dispose: this.disposeSession,
    }
  }
}

describe('SandboxJSKernel', () => {
  it('passes the top-level embed helper into the dynamic runner', () => {
    const srcDoc = buildSandboxSrcDoc({
      enableOpfs: true,
      enableNet: true,
    })

    expect(srcDoc).toMatch(/"tour",\s+"ui",\s+"opfs",\s+"net",\s+"embed"/)
    expect(srcDoc).toContain(
      'runner(consoleProxy, runme, tour, ui, opfs, net, embed, notebooks'
    )
  })

  it('runs javascript and resolves runme host calls through the bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'runme.getCurrentNotebook') {
        return { name: 'sandbox-test', cellCount: 4 }
      }
      if (method === 'runme.clear') {
        return 'cleared'
      }
      return ''
    })

    const kernel = new TestableSandboxJSKernel(new MockSandboxPort('success'), {
      bridge: { call: bridgeCall },
      hooks: {
        onStdout: (data) => {
          stdout += data
        },
        onStderr: (data) => {
          stderr += data
        },
        onExit: (code) => {
          exitCode = code
        },
      },
    })

    await kernel.run("console.log('noop');")

    expect(bridgeCall).toHaveBeenCalledWith('runme.getCurrentNotebook', [])
    expect(bridgeCall).toHaveBeenCalledWith('runme.clear', [undefined])
    expect(stderr).toBe('')
    expect(stdout).toContain('sandbox-test')
    expect(stdout).toContain('4')
    expect(stdout).toContain('cleared')
    expect(exitCode).toBe(0)
  })

  it('rejects host calls that are outside the allowlist', async () => {
    let stderr = ''
    let exitCode = -1

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('disallowed'),
      {
        bridge: {
          call: vi.fn(async () => 'ignored'),
        },
        allowedMethods: ['runme.help'],
        hooks: {
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run('await runme.clear();')

    expect(stderr).toContain('Sandbox method not allowed: runme.clear')
    expect(exitCode).toBe(1)
  })

  it('disposes the sandbox session when aborted', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const disposeSession = vi.fn()
    const abortController = new AbortController()
    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('hang'),
      {
        bridge: {
          call: vi.fn(async () => 'ignored'),
        },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      },
      disposeSession
    )

    const run = kernel.run('await new Promise(() => {});', {
      signal: abortController.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    abortController.abort()
    await run

    expect(stdout).toContain('started')
    expect(stderr).toBe('')
    expect(exitCode).toBe(1)
    expect(disposeSession).toHaveBeenCalledTimes(1)
  })

  it('rejects low-level opfs and net bridge methods by default', async () => {
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async () => null)

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('lowLevel'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run("console.log('noop');")

    expect(bridgeCall).not.toHaveBeenCalled()
    expect(stderr).toContain('Sandbox method not allowed: opfs.readText')
    expect(exitCode).toBe(1)
  })

  it('allows low-level opfs and net bridge methods in code mode', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'opfs.readText') {
        return 'cached-doc'
      }
      if (method === 'net.get') {
        return { ok: true, status: 200, text: 'remote-doc' }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('lowLevel'),
      {
        bridge: { call: bridgeCall },
        allowedMethods: CODE_MODE_SANDBOX_ALLOWED_METHODS,
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run("console.log('noop');")

    expect(bridgeCall).toHaveBeenCalledWith('opfs.readText', [
      '/code/runmedev/web.txt',
    ])
    expect(bridgeCall).toHaveBeenCalledWith('net.get', [
      'https://example.test/docs',
    ])
    expect(stdout).toContain('cached-doc')
    expect(stdout).toContain('"status":200')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports AppKernel session helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'app.getSessionID') {
        return 'session-test'
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(new MockSandboxPort('app'), {
      bridge: { call: bridgeCall },
      hooks: {
        onStdout: (data) => {
          stdout += data
        },
        onStderr: (data) => {
          stderr += data
        },
        onExit: (code) => {
          exitCode = code
        },
      },
    })

    await kernel.run('console.log(app.getSessionID());')

    expect(bridgeCall).toHaveBeenCalledWith('app.getSessionID', [])
    expect(stdout).toContain('session-test')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports rendered Markdown UI helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'ui.prepareRenderedComment') {
        return { opened: true, action: 'comment-selection' }
      }
      if (method === 'ui.clearSelection') {
        return { cleared: true, rangeCount: 0 }
      }
      return null
    })
    const kernel = new TestableSandboxJSKernel(new MockSandboxPort('ui'), {
      bridge: { call: bridgeCall },
      hooks: {
        onStdout: (data) => {
          stdout += data
        },
        onStderr: (data) => {
          stderr += data
        },
        onExit: (code) => {
          exitCode = code
        },
      },
    })

    await kernel.run(`
      const prepared = await ui.prepareRenderedComment({
        target: { uri: "local://fixture.ipynb" },
        cellId: "cell-1",
        selector: { type: "TextQuoteSelector", exact: "guide" },
      });
      console.log(JSON.stringify(prepared));
      console.log(JSON.stringify(await ui.clearSelection()));
    `)

    expect(bridgeCall).toHaveBeenCalledWith('ui.prepareRenderedComment', [
      {
        target: { uri: 'local://fixture.ipynb' },
        cellId: 'cell-1',
        selector: { type: 'TextQuoteSelector', exact: 'guide' },
      },
    ])
    expect(bridgeCall).toHaveBeenCalledWith('ui.clearSelection', [])
    expect(stdout).toContain('"action":"comment-selection"')
    expect(stdout).toContain('"cleared":true')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports tour guide helpers through the sandbox bridge', async () => {
    let stdout = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'tour.listTargets') {
        return [{ id: 'left-nav.google-drive', label: 'Google Drive' }]
      }
      if (method === 'tour.show') {
        return { target: 'left-nav.google-drive', message: 'Sign in here.' }
      }
      if (method === 'tour.getUiSnapshot') {
        return { revision: 2, activePanel: 'explorer' }
      }
      if (method === 'tour.waitForUiChange') {
        return { revision: 3, activePanel: 'explorer', timedOut: false }
      }
      if (method === 'tour.setActivePanel') {
        return { revision: 3, activePanel: 'explorer' }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(new MockSandboxPort('tour'), {
      bridge: { call: bridgeCall },
      hooks: {
        onStdout: (data) => {
          stdout += data
        },
        onExit: (code) => {
          exitCode = code
        },
      },
    })

    await kernel.run(
      [
        'console.log(await tour.listTargets());',
        'console.log(await tour.getUiSnapshot());',
        'console.log(await tour.waitForUiChange({ afterRevision: 2, timeoutMs: 1000 }));',
        "console.log(await tour.setActivePanel('explorer'));",
        "console.log(await tour.show({ target: 'left-nav.google-drive', message: 'Sign in here.' }));",
      ].join('\n')
    )

    expect(bridgeCall).toHaveBeenCalledWith('tour.listTargets', [])
    expect(bridgeCall).toHaveBeenCalledWith('tour.getUiSnapshot', [])
    expect(bridgeCall).toHaveBeenCalledWith('tour.waitForUiChange', [
      { afterRevision: 2, timeoutMs: 1_000 },
    ])
    expect(bridgeCall).toHaveBeenCalledWith('tour.setActivePanel', ['explorer'])
    expect(bridgeCall).toHaveBeenCalledWith('tour.show', [
      { target: 'left-nav.google-drive', message: 'Sign in here.' },
    ])
    expect(stdout).toContain('left-nav.google-drive')
    expect(exitCode).toBe(0)
  })

  it('supports Google Drive auth helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'drive.authorize') {
        return {
          status: 'started',
          authFlow: 'implicit',
          mode: 'new_tab',
        }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(new MockSandboxPort('drive'), {
      bridge: { call: bridgeCall },
      hooks: {
        onStdout: (data) => {
          stdout += data
        },
        onStderr: (data) => {
          stderr += data
        },
        onExit: (code) => {
          exitCode = code
        },
      },
    })

    await kernel.run("console.log(await drive.authorize({ mode: 'new_tab' }));")

    expect(bridgeCall).toHaveBeenCalledWith('drive.authorize', [
      { mode: 'new_tab' },
    ])
    expect(stdout).toContain('"status":"started"')
    expect(stdout).toContain('"mode":"new_tab"')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('passes native Drive search requests through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'drive.search') {
        return {
          files: [
            {
              id: 'file123',
              name: 'eval_read.json',
              mimeType: 'application/json',
              uri: 'https://drive.google.com/file/d/file123/view',
            },
          ],
          nextPageToken: 'page-2',
        }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('driveSearch'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      'console.log(await drive.search({ q: "name = \'eval_read.json\' and trashed = false", pageSize: 25 }));'
    )

    expect(bridgeCall).toHaveBeenCalledWith('drive.search', [
      {
        q: "name = 'eval_read.json' and trashed = false",
        pageSize: 25,
      },
    ])
    expect(stdout).toContain('eval_read.json')
    expect(stdout).toContain('page-2')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports explorer folder helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'explorer.renameFolder') {
        return {
          uri: 'local://folder/drive',
          name: 'Renamed Folder',
          type: 'folder',
        }
      }
      if (method === 'explorer.editName') {
        return 'Editing name: local://folder/drive'
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('explorer'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      [
        "console.log(await explorer.renameFolder('local://folder/drive', 'Renamed Folder'));",
        "console.log(await explorer.editName('local://folder/drive'));",
      ].join('\n')
    )

    expect(bridgeCall).toHaveBeenCalledWith('explorer.renameFolder', [
      'local://folder/drive',
      'Renamed Folder',
    ])
    expect(bridgeCall).toHaveBeenCalledWith('explorer.editName', [
      'local://folder/drive',
    ])
    expect(stdout).toContain('Renamed Folder')
    expect(stdout).toContain('Editing name: local://folder/drive')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports notebook write access requests through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'notebooks.requestWriteAccess') {
        return {
          summary: {
            uri: 'local://file/demo',
            readOnly: false,
          },
        }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('notebooksWriteAccess'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      "console.log(await notebooks.requestWriteAccess({ target: { uri: 'local://file/demo' } }));"
    )

    expect(bridgeCall).toHaveBeenCalledWith('notebooks.requestWriteAccess', [
      { target: { uri: 'local://file/demo' } },
    ])
    expect(stdout).toContain('"readOnly":false')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports Google service account helper through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'credentials.google.setServiceAccountFromFilePath') {
        return {
          authFlow: 'service_account',
          serviceAccount: {
            clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
          },
        }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('credentials'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      "console.log(await credentials.google.setServiceAccountFromFilePath('/tmp/service-account.json'));"
    )

    expect(bridgeCall).toHaveBeenCalledWith(
      'credentials.google.setServiceAccountFromFilePath',
      ['/tmp/service-account.json']
    )
    expect(stdout).toContain('"authFlow":"service_account"')
    expect(stdout).toContain('runme-drive-test@example.iam.gserviceaccount.com')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports raw document helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string, args: unknown[]) => {
      if (method === 'documents.list') {
        return [
          {
            title: 'Getting Started',
            uri: 'https://github.com/runmedev/web/blob/abc123/docs/00-getting-started.md',
          },
        ]
      }
      if (method === 'documents.get') {
        return {
          uri: args[0],
          name: 'test4.excalidraw',
          mimeType: 'application/vnd.excalidraw+json',
          content: '{"type":"excalidraw","elements":[]}',
        }
      }
      if (method === 'documents.update') {
        return {
          uri: args[0],
          name: 'test4.excalidraw',
          mimeType: (args[2] as { mimeType?: string } | undefined)?.mimeType,
          syncStatus: 'local-only',
        }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('documents'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      [
        'console.log(await documents.list());',
        "const doc = await documents.get('local://file/test4');",
        'const scene = JSON.parse(doc.content);',
        "scene.elements.push({ id: 'label', type: 'text', text: 'Box A' });",
        'console.log(await documents.update(doc.uri, JSON.stringify(scene), { mimeType: doc.mimeType }));',
      ].join('\n')
    )

    expect(bridgeCall).toHaveBeenCalledWith('documents.list', [])
    expect(bridgeCall).toHaveBeenCalledWith('documents.get', [
      'local://file/test4',
    ])
    expect(bridgeCall).toHaveBeenCalledWith('documents.update', [
      'local://file/test4',
      '{"type":"excalidraw","elements":[{"id":"label","type":"text","text":"Box A"}]}',
      { mimeType: 'application/vnd.excalidraw+json' },
    ])
    expect(stdout).toContain('test4.excalidraw')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports read-only documentation helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string, args: unknown[]) => {
      if (method === 'documentation.list') {
        return [
          {
            name: 'getting-started',
            description: 'Open a notebook and run a cell.',
          },
        ]
      }
      if (method === 'documentation.get') {
        return `# ${args[0]}`
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('documentation'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      [
        'console.log(await documentation.list());',
        "console.log(await documentation.get('getting-started'));",
      ].join('\n')
    )

    expect(bridgeCall).toHaveBeenCalledWith('documentation.list', [])
    expect(bridgeCall).toHaveBeenCalledWith('documentation.get', [
      'getting-started',
    ])
    expect(stdout).toContain('getting-started')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports notebook comment and anchor helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'comments.list') {
        return [
          {
            id: 'comment-1',
            content: 'Clarify this.',
            currentResolution: { status: 'exact', start: 5, end: 24 },
          },
        ]
      }
      if (method === 'comments.resolve') {
        return { action: 'resolve' }
      }
      return null
    })
    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('comments'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      [
        "const found = await comments.list({ target: { uri: 'local://file/test' }, status: 'open' });",
        'console.log(found);',
        "console.log(await comments.resolve({ target: { uri: 'local://file/test' }, commentId: 'comment-1' }));",
      ].join('\n')
    )

    expect(bridgeCall).toHaveBeenCalledWith('comments.list', [
      { target: { uri: 'local://file/test' }, status: 'open' },
    ])
    expect(bridgeCall).toHaveBeenCalledWith('comments.resolve', [
      { target: { uri: 'local://file/test' }, commentId: 'comment-1' },
    ])
    expect(stdout).toContain('Clarify this.')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports saving the current notebook to Drive through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'drive.saveAsCurrentNotebook') {
        return {
          fileId: 'drive-file-1',
          fileName: 'Comments demo.ipynb',
          remoteUri: 'https://drive.google.com/file/d/drive-file-1/view',
          localUri: 'local://drive-file-1',
        }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('driveSave'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      "console.log(await drive.saveAsCurrentNotebook('root', 'Comments demo.ipynb'));"
    )

    expect(bridgeCall).toHaveBeenCalledWith('drive.saveAsCurrentNotebook', [
      'root',
      'Comments demo.ipynb',
    ])
    expect(stdout).toContain('"fileId":"drive-file-1"')
    expect(stdout).toContain('Comments demo.ipynb')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports local notebook creation helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'notebooks.createLocal') {
        return {
          handle: { uri: 'local://file/comments-demo', revision: '1' },
        }
      }
      if (method === 'notebooks.appendCell') {
        return {
          handle: { uri: 'local://file/comments-demo', revision: '2' },
          cell: { refId: 'cell-comments-demo', value: '# Comments demo' },
        }
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('notebooksCreate'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      "const created = await notebooks.createLocal('Comments demo.ipynb'); console.log(await notebooks.appendCell({ target: { handle: created.handle }, kind: 'markup', value: '# Comments demo' }));"
    )

    expect(bridgeCall).toHaveBeenCalledWith('notebooks.createLocal', [
      'Comments demo.ipynb',
      undefined,
    ])
    expect(bridgeCall).toHaveBeenCalledWith('notebooks.appendCell', [
      {
        target: {
          handle: { uri: 'local://file/comments-demo', revision: '1' },
        },
        kind: 'markup',
        value: '# Comments demo',
      },
    ])
    expect(stdout).toContain('cell-comments-demo')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('supports image embedding through top-level and notebooks sandbox helpers', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'embed' || method === 'notebooks.embed') {
        return {
          uri: 'local://file/images',
          cell: { refId: 'image-cell', languageId: 'html' },
        }
      }
      return null
    })
    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('notebooksEmbed'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run(
      "console.log(await embed('/tmp/screenshot.png', { alt: 'Screenshot' })); console.log(await notebooks.embed('data:image/png;base64,AQID'));"
    )

    expect(bridgeCall).toHaveBeenCalledWith('embed', [
      '/tmp/screenshot.png',
      { alt: 'Screenshot' },
    ])
    expect(bridgeCall).toHaveBeenCalledWith('notebooks.embed', [
      'data:image/png;base64,AQID',
      undefined,
    ])
    expect(stdout).toContain('image-cell')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('serializes structured notebook update errors through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async () => {
      throw new NotebookUpdateError({
        method: 'notebooks.update',
        code: 'NOTEBOOK_UPDATE_FAILED',
        failedOperationIndex: 1,
        failedOperation: {
          op: 'update',
          refId: 'missing-cell',
          patch: { value: 'echo missing' },
        },
        failedOperationError: 'Cell not found: missing-cell',
        appliedOperationCount: 1,
        operationStatuses: [
          { index: 0, status: 'applied' },
          {
            index: 1,
            status: 'failed',
            error: 'Cell not found: missing-cell',
          },
        ],
        beforeHandle: { uri: 'local://file/demo', revision: 'before' },
        afterHandle: { uri: 'local://file/demo', revision: 'after' },
      })
    })

    const kernel = new TestableSandboxJSKernel(
      new MockSandboxPort('notebooksUpdateError'),
      {
        bridge: { call: bridgeCall },
        hooks: {
          onStdout: (data) => {
            stdout += data
          },
          onStderr: (data) => {
            stderr += data
          },
          onExit: (code) => {
            exitCode = code
          },
        },
      }
    )

    await kernel.run('await notebooks.update({ operations: [] });')

    const serialized = JSON.parse(stdout)
    expect(bridgeCall).toHaveBeenCalledWith('notebooks.update', [
      {
        target: { uri: 'local://file/demo' },
        operations: [],
      },
    ])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(serialized).toMatchObject({
      name: 'NotebookUpdateError',
      code: 'NOTEBOOK_UPDATE_FAILED',
      details: {
        failedOperationIndex: 1,
        appliedOperationCount: 1,
        operationStatuses: [
          { index: 0, status: 'applied' },
          {
            index: 1,
            status: 'failed',
            error: 'Cell not found: missing-cell',
          },
        ],
      },
    })
  })
})
