// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import {
  CODE_MODE_SANDBOX_ALLOWED_METHODS,
  SandboxJSKernel,
} from './sandboxJsKernel'

type Scenario =
  | 'success'
  | 'disallowed'
  | 'hang'
  | 'lowLevel'
  | 'codex'
  | 'app'
  | 'explorer'
  | 'credentials'
  | 'drive'
  | 'driveSearch'
  | 'driveSave'
  | 'documents'
  | 'notebooksCreate'

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
      } else if (this.scenario === 'codex') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'codex.turns.list',
          args: [],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'codex.turns.getEvents',
          args: ['turn-latest', undefined],
        })
      } else if (this.scenario === 'app') {
        this.emit({
          type: 'host-call',
          callId: 1,
          method: 'app.getSessionID',
          args: [],
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
          method: 'documents.get',
          args: ['local://file/test4'],
        })
        this.emit({
          type: 'host-call',
          callId: 2,
          method: 'documents.update',
          args: [
            'local://file/test4',
            '{"type":"excalidraw","elements":[{"id":"label","type":"text","text":"Box A"}]}',
            { mimeType: 'application/vnd.excalidraw+json' },
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
              target: { handle: { uri: 'local://file/comments-demo', revision: '1' } },
              kind: 'markup',
              value: '# Comments demo',
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
        } else if (this.scenario === 'codex') {
          const turns = this.hostResults.get(1) as
            | Array<{ turnId?: string }>
            | undefined
          const events = this.hostResults.get(2) as Array<unknown> | undefined
          this.emit({
            type: 'stdout',
            data: `${turns?.[0]?.turnId ?? ''}\n`,
          })
          this.emit({
            type: 'stdout',
            data: `${events?.length ?? 0}\n`,
          })
          this.emit({ type: 'exit', exitCode: 0 })
        }
      }
      return
    }

    if (type === 'host-error') {
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

  it('supports codex turn journal helpers through the sandbox bridge', async () => {
    let stdout = ''
    let stderr = ''
    let exitCode = -1
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'codex.turns.list') {
        return [{ turnId: 'turn-latest' }]
      }
      if (method === 'codex.turns.getEvents') {
        return [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
      }
      return null
    })

    const kernel = new TestableSandboxJSKernel(new MockSandboxPort('codex'), {
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

    expect(bridgeCall).toHaveBeenCalledWith('codex.turns.list', [])
    expect(bridgeCall).toHaveBeenCalledWith('codex.turns.getEvents', [
      'turn-latest',
      undefined,
    ])
    expect(stdout).toContain('turn-latest')
    expect(stdout).toContain('\n3\n')
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
      "console.log(await drive.search({ q: \"name = 'eval_read.json' and trashed = false\", pageSize: 25 }));"
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
        "const doc = await documents.get('local://file/test4');",
        "const scene = JSON.parse(doc.content);",
        "scene.elements.push({ id: 'label', type: 'text', text: 'Box A' });",
        "console.log(await documents.update(doc.uri, JSON.stringify(scene), { mimeType: doc.mimeType }));",
      ].join('\n')
    )

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

    const kernel = new TestableSandboxJSKernel(new MockSandboxPort('driveSave'), {
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
        target: { handle: { uri: 'local://file/comments-demo', revision: '1' } },
        kind: 'markup',
        value: '# Comments demo',
      },
    ])
    expect(stdout).toContain('cell-comments-demo')
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })
})
