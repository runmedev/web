// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import {
  CODE_MODE_SANDBOX_ALLOWED_METHODS,
  SandboxJSKernel,
} from './sandboxJsKernel'

type Scenario = 'success' | 'disallowed' | 'hang' | 'lowLevel'

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
})
