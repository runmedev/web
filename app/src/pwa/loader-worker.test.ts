// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import { digest, startupMarker } from '../releases/control'

/** Run the actual emitted worker's fetch handler with a cache containing the
 * reserialized completion marker. Discovery must receive the published bytes.
 */
describe('loader manifest discovery', () => {
  it('leaves deployment config requests to the network, outside release caches', () => {
    const listeners = new Map<string, (event: unknown) => void>()
    const openCache = vi.fn()
    const source = readFileSync(
      new URL('./loader-worker.js', import.meta.url),
      'utf8'
    )
      .replace('__RUNME_LOADER_SHELL__', '"shell"')
      .replace('__RUNME_LOADER_BOOTSTRAP__', '[]')
    runInNewContext(source, {
      self: {
        location: { origin: 'https://runme.test' },
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          listeners.set(name, handler),
      },
      caches: { open: openCache },
      URL,
    })
    const respondWith = vi.fn()
    listeners.get('fetch')!({
      request: new Request('https://runme.test/configs/app-configs.yaml', {
        cache: 'no-store',
      }),
      respondWith,
    })
    expect(respondWith).not.toHaveBeenCalled()
    expect(openCache).not.toHaveBeenCalled()
  })

  it('verifies on-demand fonts using startup metadata before the full offline marker exists', async () => {
    const id = `${'a'.repeat(40)}-${'b'.repeat(64)}`
    const sha256 = await digest(new TextEncoder().encode('verified').buffer)
    const manifest = { assets: [{ path: 'font.woff2', bytes: 8, sha256 }] }
    const listeners = new Map<string, (event: unknown) => void>()
    const put = vi.fn()
    const fetcher = vi.fn(async () => new Response('tampered'))
    const source = readFileSync(
      new URL('./loader-worker.js', import.meta.url),
      'utf8'
    )
      .replace('__RUNME_LOADER_SHELL__', '"shell"')
      .replace('__RUNME_LOADER_BOOTSTRAP__', '[]')
    runInNewContext(source, {
      self: {
        location: { origin: 'https://runme.test' },
        addEventListener: (name: string, fn: (event: unknown) => void) =>
          listeners.set(name, fn),
      },
      caches: {
        open: async () => ({
          put,
          match: async (path: string) =>
            path === startupMarker(id)
              ? new Response(JSON.stringify(manifest))
              : undefined,
        }),
      },
      fetch: fetcher,
      URL,
      Response,
      crypto: globalThis.crypto,
    })
    const request = new Request(`https://runme.test/version/${id}/font.woff2`)
    const read = () =>
      new Promise<Response>((resolve) =>
        listeners.get('fetch')!({ request, respondWith: resolve })
      )
    expect((await read()).status).toBe(502)
    expect(put).not.toHaveBeenCalled()
    fetcher.mockImplementation(async () => new Response('verified'))
    expect(await (await read()).text()).toBe('verified')
    expect(put).toHaveBeenCalledTimes(1)
  })
  it('does not substitute a local completion marker for the published manifest', async () => {
    const id = `${'a'.repeat(40)}-${'b'.repeat(64)}`
    const original = '{\n  "format": 1,\n  "assets": []\n}\n'
    const marker = JSON.stringify(JSON.parse(original))
    const listeners = new Map<string, (event: unknown) => void>()
    const match = vi.fn(async () => new Response(marker))
    const fetcher = vi.fn(async () => new Response(original))
    const source = readFileSync(
      new URL('./loader-worker.js', import.meta.url),
      'utf8'
    )
      .replace('__RUNME_LOADER_SHELL__', '"shell"')
      .replace('__RUNME_LOADER_BOOTSTRAP__', '[]')
    runInNewContext(source, {
      self: {
        location: { origin: 'https://runme.test' },
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          listeners.set(name, handler),
      },
      caches: { open: async () => ({ match }) },
      fetch: fetcher,
      URL,
      Response,
    })
    const request = new Request(
      `https://runme.test/version/${id}/release.json`,
      { cache: 'no-store' }
    )
    let response: Promise<Response> | undefined
    listeners.get('fetch')!({
      request,
      respondWith: (value: Promise<Response>) => {
        response = value
      },
    })
    expect(await (await response!).text()).toBe(original)
    expect(fetcher).toHaveBeenCalledWith(request)
    expect(match).not.toHaveBeenCalled()
  })
})

/** Exercise the actual waiting worker's explicit migration handshake. */
function migrationWorker(
  peers: { id: string; postMessage?: (...args: any[]) => void }[]
) {
  const listeners = new Map<string, (event: any) => void>()
  const known = new Set<string>()
  const skipWaiting = vi.fn(async () => {})
  const source = readFileSync(
    new URL('./loader-worker.js', import.meta.url),
    'utf8'
  )
    .replace('__RUNME_LOADER_SHELL__', '"shell"')
    .replace('__RUNME_LOADER_BOOTSTRAP__', '[]')
  runInNewContext(source, {
    self: {
      clients: { matchAll: async () => peers },
      skipWaiting,
      addEventListener: (name: string, listener: (event: any) => void) =>
        listeners.set(name, listener),
    },
    caches: {
      open: async () => ({
        put: async (key: string) => {
          known.add(key)
        },
        match: async (key: string) => known.has(key),
      }),
    },
    Response,
    setTimeout,
    clearTimeout,
    MessageChannel: class {
      port1 = { close() {}, onmessage: undefined }
      port2 = {}
    },
  })
  return { receive: listeners.get('message')!, skipWaiting }
}

it('activates the new navigation shell only after an explicit compatible migration request', async () => {
  const worker = migrationWorker([{ id: 'current' }])
  const reply = vi.fn()
  let work: Promise<void> | undefined
  worker.receive({
    data: 'runme-loader-upgrade',
    ports: [{ postMessage: reply }],
  })
  expect(worker.skipWaiting).not.toHaveBeenCalled()
  worker.receive({
    data: 'runme-loader-upgrade',
    source: { id: 'current' },
    ports: [{ postMessage: reply }],
    waitUntil: (task: Promise<void>) => {
      work = task
    },
  })
  await work
  expect(worker.skipWaiting).toHaveBeenCalledOnce()
  expect(reply).toHaveBeenCalledWith('runme-loader-1')
})

it('does not activate a waiting loader while an unknown window fails its compatibility probe', async () => {
  vi.useFakeTimers()
  try {
    const worker = migrationWorker([{ id: 'unknown', postMessage() {} }])
    const reply = vi.fn()
    let work: Promise<void> | undefined
    worker.receive({
      data: 'runme-loader-upgrade',
      source: { id: 'current' },
      ports: [{ postMessage: reply }],
      waitUntil: (task: Promise<void>) => {
        work = task
      },
    })
    await vi.advanceTimersByTimeAsync(2000)
    await work
    expect(worker.skipWaiting).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('close all older Runme tabs')
    )
  } finally {
    vi.useRealTimers()
  }
})
