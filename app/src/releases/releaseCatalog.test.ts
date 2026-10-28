import { afterEach, expect, it, vi } from 'vitest'

import { resolvePublishedRelease } from './releaseCatalog'

const id = `${'a'.repeat(40)}-${'b'.repeat(64)}`
afterEach(() => vi.unstubAllGlobals())
it('accepts a full release ID without requiring catalog or settings access', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(await resolvePublishedRelease(id)).toBe(id)
  expect(fetch).not.toHaveBeenCalled()
})
it.each([0, 1, 2])(
  'requires exactly one published build for a commit (%s matches)',
  async (count) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          format: 1,
          releases: [id, `${'a'.repeat(40)}-${'c'.repeat(64)}`]
            .slice(0, count)
            .map((releaseId) => ({ releaseId })),
        }),
      }))
    )
    if (count === 1) expect(await resolvePublishedRelease('aaaaaaa')).toBe(id)
    else
      await expect(resolvePublishedRelease('aaaaaaa')).rejects.toThrow(
        count ? 'Multiple builds' : 'No published release'
      )
  }
)
