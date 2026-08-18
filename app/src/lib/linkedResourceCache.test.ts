// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  LinkedResourceCache,
  MemoryLinkedResourceCacheIndex,
  linkedResourcePrincipalKey,
} from './linkedResourceCache'
import type { DriveResourceStore } from './linkedResourceStore'

class MemoryFileHandle {
  data = new Uint8Array()

  async getFile() {
    return new Blob([this.data]) as File
  }

  async createWritable() {
    const chunks: Uint8Array[] = []
    return {
      write: async (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)),
      close: async () => {
        const size = chunks.reduce(
          (total, chunk) => total + chunk.byteLength,
          0
        )
        const merged = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }
        this.data = merged
      },
      abort: async () => {
        chunks.length = 0
      },
    } as unknown as FileSystemWritableFileStream
  }
}

class MemoryDirectoryHandle {
  readonly directories = new Map<string, MemoryDirectoryHandle>()
  readonly files = new Map<string, MemoryFileHandle>()

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let directory = this.directories.get(name)
    if (!directory && options?.create) {
      directory = new MemoryDirectoryHandle()
      this.directories.set(name, directory)
    }
    if (!directory) {
      throw new DOMException('Missing directory', 'NotFoundError')
    }
    return directory as unknown as FileSystemDirectoryHandle
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name)
    if (!file && options?.create) {
      file = new MemoryFileHandle()
      this.files.set(name, file)
    }
    if (!file) {
      throw new DOMException('Missing file', 'NotFoundError')
    }
    return file as unknown as FileSystemFileHandle
  }

  async removeEntry(name: string) {
    this.files.delete(name)
    this.directories.delete(name)
  }
}

function makeStore(permissionId = 'principal-a'): DriveResourceStore {
  return {
    getPrincipal: vi.fn().mockResolvedValue({ permissionId }),
    uploadResource: vi.fn(),
    getResourceMetadata: vi.fn(),
    fetch: vi.fn().mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'Content-Length': '4' },
        })
    ),
  }
}

const metadata = {
  uri: 'https://drive.google.com/file/d/file-123/view',
  name: 'demo.webm',
  mimeType: 'video/webm',
  sizeBytes: 4,
  md5Checksum: 'version-a',
  canDownload: true,
}

function makeCache() {
  const root = new MemoryDirectoryHandle()
  const index = new MemoryLinkedResourceCacheIndex()
  const storage = {
    getDirectory: async () => root as unknown as FileSystemDirectoryHandle,
    estimate: async () => ({ quota: 1024 * 1024, usage: 0 }),
  } as unknown as StorageManager
  return {
    root,
    index,
    cache: new LinkedResourceCache({
      index,
      storage,
      randomId: () => 'download-1',
      now: () => new Date('2026-08-18T00:00:00Z'),
    }),
  }
}

describe('LinkedResourceCache', () => {
  it('hashes the opaque principal rather than storing it as the namespace', async () => {
    const key = await linkedResourcePrincipalKey('permission-id')
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(key).not.toContain('permission-id')
  })

  it('streams a Drive response into OPFS before committing its index record', async () => {
    const { cache, index } = makeCache()
    const store = makeStore()
    const loaded = await cache.load(store, metadata)

    expect(loaded.source).toBe('opfs')
    expect(loaded.file.size).toBe(4)
    const records = await index.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      sourceUri: metadata.uri,
      sizeBytes: 4,
      versionKey: 'version-a',
    })
    expect(records[0]?.opfsPath).not.toContain('permission-id')
  })

  it('reuses only a complete committed payload', async () => {
    const { cache } = makeCache()
    const store = makeStore()
    await cache.load(store, metadata)
    await cache.load(store, metadata)

    expect(store.fetch).toHaveBeenCalledTimes(1)
  })

  it('isolates entries by principal and file version', async () => {
    const { cache, index } = makeCache()
    const firstStore = makeStore('principal-a')
    const secondStore = makeStore('principal-b')
    await cache.load(firstStore, metadata)
    await cache.load(secondStore, metadata)
    await cache.load(firstStore, { ...metadata, md5Checksum: 'version-b' })

    const records = await index.list()
    expect(records).toHaveLength(3)
    expect(new Set(records.map((record) => record.principalKey)).size).toBe(2)
    expect(new Set(records.map((record) => record.versionKey))).toEqual(
      new Set(['version-a', 'version-b'])
    )
  })

  it('falls back to bounded memory when OPFS is unavailable', async () => {
    const index = new MemoryLinkedResourceCacheIndex()
    const store = makeStore()
    const cache = new LinkedResourceCache({
      index,
      storage: null,
      maxInMemoryBytes: 4,
    })

    await expect(cache.load(store, metadata)).resolves.toMatchObject({
      source: 'memory',
    })
    await expect(
      cache.load(store, { ...metadata, sizeBytes: 5 })
    ).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE_FOR_FALLBACK' })
    expect(await index.list()).toHaveLength(0)
  })

  it('does not expose cached bytes when Drive says download is restricted', async () => {
    const { cache } = makeCache()
    const store = makeStore()
    await expect(
      cache.load(store, { ...metadata, canDownload: false })
    ).rejects.toMatchObject({ code: 'DOWNLOAD_RESTRICTED' })
    expect(store.getPrincipal).not.toHaveBeenCalled()
    expect(store.fetch).not.toHaveBeenCalled()
  })

  it('does not commit an interrupted stream', async () => {
    const { cache, index } = makeCache()
    const store = makeStore()
    vi.mocked(store.fetch).mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]))
            controller.error(new Error('connection lost'))
          },
        }),
        { headers: { 'Content-Length': '4' } }
      )
    )

    await expect(cache.load(store, metadata)).rejects.toMatchObject({
      code: 'DOWNLOAD_INTERRUPTED',
    })
    expect(await index.list()).toHaveLength(0)
  })

  it('clears committed media and reports the freed bytes', async () => {
    const { cache, index } = makeCache()
    await cache.load(makeStore(), metadata)

    await expect(cache.clear()).resolves.toBe(4)
    expect(await index.list()).toHaveLength(0)
  })
})
