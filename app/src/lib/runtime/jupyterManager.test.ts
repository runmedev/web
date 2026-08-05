// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Kernel = {
  id: string
  name: string
  execution_state?: string
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockRuntime(idToken = '') {
  vi.doMock('./runnersManager', () => ({
    DEFAULT_RUNNER_PLACEHOLDER: '<default>',
    getRunnersManager: () => ({
      getDefaultRunnerName: () => 'dev',
      getWithFallback: () => ({
        name: 'dev',
        endpoint: 'http://127.0.0.1:5191',
      }),
    }),
  }))
  vi.doMock('../../token', () => ({
    getAuthData: vi.fn(async () => (idToken ? { idToken } : null)),
  }))
  vi.doMock('../../browserAdapter.client', () => ({
    getBrowserAdapter: () => ({ simpleAuth: {} }),
  }))
}

describe('jupyterManager direct kernel API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('starts a kernel with the current OIDC ID token and caches it for selection', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          {
            id: 'kernel-direct-1',
            name: 'python3',
            execution_state: 'starting',
          },
          201
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    mockRuntime('test-id-token')

    const { getJupyterManager } = await import('./jupyterManager')
    const manager = getJupyterManager()
    const kernel = await manager.startKernel('dev', {
      kernelSpec: 'python3',
    })

    expect(kernel.id).toBe('kernel-direct-1')
    expect(manager.getKernelOptionsForRunner('dev')).toEqual([
      expect.objectContaining({
        key: 'dev:kernel-direct-1',
        runnerName: 'dev',
        kernelId: 'kernel-direct-1',
        kernelName: 'python3',
      }),
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:5191/v1/jupyter/kernels')
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ name: 'python3' }),
      })
    )
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-id-token'
    )
  })

  it('persists kernel aliases and restores labels after manager reload', async () => {
    const kernels: Kernel[] = []
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/v1/jupyter/kernels') && method === 'GET') {
          return jsonResponse(kernels)
        }
        if (url.endsWith('/v1/jupyter/kernels') && method === 'POST') {
          const body = init?.body ? JSON.parse(String(init.body)) : {}
          const created = {
            id: 'kernel-1',
            name: typeof body.name === 'string' ? body.name : 'python3',
            execution_state: 'starting',
          }
          kernels.push(created)
          return jsonResponse(created, 201)
        }
        throw new Error(`Unexpected request: ${method} ${url}`)
      }
    )
    vi.stubGlobal('fetch', fetchMock)
    mockRuntime()

    const firstModule = await import('./jupyterManager')
    await firstModule.getJupyterManager().startKernel('dev', {
      kernelSpec: 'python3',
      name: 'py3-local-1',
    })
    expect(window.localStorage.getItem('runme/jupyterKernelAliases')).toContain(
      'py3-local-1'
    )

    vi.resetModules()
    mockRuntime()
    const secondModule = await import('./jupyterManager')
    const secondManager = secondModule.getJupyterManager()
    await secondManager.listKernels('dev')
    expect(secondManager.getKernelOptionsForRunner('dev')[0]?.label).toBe(
      'py3-local-1'
    )
  })

  it('rejects duplicate aliases on kernel start', async () => {
    const kernels: Kernel[] = []
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET') {
          return jsonResponse(kernels)
        }
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        const created = {
          id: `kernel-${kernels.length + 1}`,
          name: typeof body.name === 'string' ? body.name : 'python3',
        }
        kernels.push(created)
        return jsonResponse(created, 201)
      }
    )
    vi.stubGlobal('fetch', fetchMock)
    mockRuntime()

    const { getJupyterManager } = await import('./jupyterManager')
    const manager = getJupyterManager()
    await manager.startKernel('dev', {
      kernelSpec: 'python3',
      name: 'openai2',
    })

    await expect(
      manager.startKernel('dev', {
        kernelSpec: 'python3',
        name: 'openai2',
      })
    ).rejects.toThrow('Kernel alias "openai2" already exists')
  })

  it('interrupts a running kernel through the direct route', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    mockRuntime()

    const { getJupyterManager } = await import('./jupyterManager')
    const abortController = new AbortController()
    await getJupyterManager().interruptKernel('dev', 'kernel-1', {
      signal: abortController.signal,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5191/v1/jupyter/kernels/kernel-1/interrupt',
      expect.objectContaining({
        method: 'POST',
        signal: abortController.signal,
      })
    )
  })

  it('builds the direct kernel channels URL', async () => {
    const { buildJupyterChannelsWebSocketURL } = await import(
      './jupyterManager'
    )
    expect(
      buildJupyterChannelsWebSocketURL({
        runnerEndpoint: 'http://127.0.0.1:5191',
        kernelId: 'kernel/1',
        authorization: 'Bearer token',
      })
    ).toBe(
      'ws://127.0.0.1:5191/v1/jupyter/kernels/kernel%2F1/channels?authorization=Bearer+token'
    )
  })
})
