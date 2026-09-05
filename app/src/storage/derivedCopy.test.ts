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
    waitForCreateOperation: vi.fn(
      async (
        _parent: string | null,
        _operation: string
      ): Promise<NotebookStoreItem | null> => null
    ), // Deliberately stale index.
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
  it.each(['f', 'r', 'p'])(
    're-elects an inherited %s claim for a copied source',
    async (kind) => {
      const server = remote(true)
      const client = server.client()
      const original = await ensureDerivedCopy(
        client as unknown as DriveNotebookStore,
        source,
        parent,
        'original.ipynb',
        async () => '{}'
      )
      server.state.claim = kind + server.state.claim!.slice(1)
      client.getDerivedCopyTarget.mockClear()
      const copied = await ensureDerivedCopy(
        client as unknown as DriveNotebookStore,
        driveFileUrl('copied-source'),
        parent,
        'copy.ipynb',
        async () => '{}'
      )
      expect(copied?.uri).not.toBe(original?.uri)
      expect(server.files.get(original!.uri)?.name).toBe('original.ipynb')
      expect(client.getDerivedCopyTarget).not.toHaveBeenCalledWith(
        original!.uri,
        expect.anything()
      )
      expect(server.state.creates).toBe(2)
    }
  )

  it('recovers an unconfirmed copy in its old folder after the source moves', async () => {
    const server = remote(false)
    const client = server.client()
    const create = client.createContent.getMockImplementation()!
    client.createContent.mockImplementationOnce(async (...args) => {
      await create(...args)
      throw new Error('response lost')
    })
    await expect(
      ensureDerivedCopy(
        client as unknown as DriveNotebookStore,
        source,
        parent,
        'source.ipynb',
        async () => '{}'
      )
    ).rejects.toBeInstanceOf(UnconfirmedDerivedCopyError)
    const original = [...server.files.values()][0]
    client.waitForCreateOperation.mockResolvedValue(original)
    const recovered = await ensureDerivedCopy(
      client as unknown as DriveNotebookStore,
      source,
      'https://drive.google.com/drive/folders/new-parent',
      'source.ipynb',
      async () => '{}'
    )
    expect(recovered?.uri).toBe(original.uri)
    expect(client.waitForCreateOperation).toHaveBeenLastCalledWith(
      null,
      expect.stringMatching(/^runme-ipynb-/)
    )
    expect(server.state.creates).toBe(1)
  })

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
