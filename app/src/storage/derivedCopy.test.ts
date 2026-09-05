// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { UnconfirmedDerivedCopyError, ensureDerivedCopy } from './derivedCopy'
import { type DriveNotebookStore, driveFileUrl } from './drive'
import { type NotebookStoreItem, NotebookStoreItemType } from './notebook'

const source = driveFileUrl('source')
const parent = 'https://drive.google.com/drive/folders/parent'

/** Separate clients share only remote CAS state, never a local lock or cache. */
function remote(reserved: boolean) {
  const state = {
    claim: undefined as string | undefined,
    sequence: 0,
    creates: 0,
  }
  const files = new Map<string, NotebookStoreItem>()
  const client = () => ({
    getDerivedCopyClaim: vi.fn(async () => state.claim),
    compareAndSetDerivedCopyClaim: vi.fn(
      async (
        _uri: string,
        expected: string | undefined,
        next: string | null
      ) => {
        if (state.claim !== expected) return false
        state.claim = next ?? undefined
        return true
      }
    ),
    waitForCreateOperation: vi.fn(async () => null), // Deliberately stale index.
    getDerivedCopyTarget: vi.fn(async (uri: string) => files.get(uri) ?? null),
    canUsePreGeneratedFileId: vi.fn(async () => reserved),
    generateFileId: vi.fn(async () => `reserved-${++state.sequence}`),
    createContent: vi.fn(
      async (
        _parent: string,
        name: string,
        _content: string,
        _mime: string,
        options: { fileId?: string }
      ) => {
        const uri = driveFileUrl(
          options.fileId ?? `created-${++state.sequence}`
        )
        if (!files.has(uri)) {
          state.creates += 1
          files.set(uri, {
            uri,
            name,
            type: NotebookStoreItemType.File,
            children: [],
            parents: [parent],
          })
        }
        return files.get(uri)!
      }
    ),
  })
  return { state, files, client }
}

describe('source-coordinated derived copies', () => {
  it.each([true, false])(
    'elects one identity across concurrent profiles (reserved=%s)',
    async (reserved) => {
      const server = remote(reserved)
      const a = server.client()
      const b = server.client()
      const run = (client: typeof a) =>
        ensureDerivedCopy(
          client as unknown as DriveNotebookStore,
          source,
          parent,
          'source.ipynb',
          async () => '{}'
        )
      const results = await Promise.allSettled([run(a), run(b)])
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
      expect(server.state.creates).toBe(1)
      const first = await run(a)
      const second = await run(b)
      expect(first?.uri).toBe(second?.uri)
      expect(server.state.creates).toBe(1)
    }
  )

  it('allows explicit recovery when an unconfirmed Shared Drive POST never arrived', async () => {
    const server = remote(false)
    const client = server.client()
    client.createContent.mockRejectedValueOnce(
      new Error('connection lost before POST')
    )
    const run = () =>
      ensureDerivedCopy(
        client as unknown as DriveNotebookStore,
        source,
        parent,
        'source.ipynb',
        async () => '{}'
      )
    await expect(run()).rejects.toBeInstanceOf(UnconfirmedDerivedCopyError)
    const pending = server.state.claim
    await expect(run()).rejects.toBeInstanceOf(UnconfirmedDerivedCopyError)
    expect(client.createContent).toHaveBeenCalledTimes(1)
    expect(
      await client.compareAndSetDerivedCopyClaim(source, pending, null)
    ).toBe(true)
    expect((await run())?.uri).toBeDefined()
    expect(server.state.creates).toBe(1)
  })

  it('does not clear a confirmed file using a stale recovery claim', async () => {
    const server = remote(false)
    const client = server.client()
    server.state.claim = 'f:already-confirmed'
    expect(
      await client.compareAndSetDerivedCopyClaim(source, 'p:old', null)
    ).toBe(false)
    expect(server.state.claim).toBe('f:already-confirmed')
  })
})
