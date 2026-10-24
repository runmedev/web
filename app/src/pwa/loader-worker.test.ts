// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/** Run the actual emitted worker's fetch handler with a cache containing the
 * reserialized completion marker. Discovery must receive the published bytes.
 */
describe('loader manifest discovery', () => {
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
