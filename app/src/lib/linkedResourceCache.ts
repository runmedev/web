import Dexie, { type Table } from 'dexie'

import { LinkedResourceError, parseGoogleDriveFileId } from './linkedResource'
import type {
  DriveResourceMetadata,
  DriveResourceStore,
} from './linkedResourceStore'
import { ensurePersistentStorage } from './persistentStorage'

export const MAX_IN_MEMORY_MEDIA_BYTES = 64 * 1024 * 1024
const CACHE_ROOT_SEGMENTS = ['runme', 'linked-resources', 'google-drive']
const DEFAULT_CACHE_QUOTA_FRACTION = 0.25

export type LinkedResourceCacheRecord = {
  key: string
  provider: 'google-drive'
  principalKey: string
  sourceUri: string
  versionKey: string
  opfsPath: string
  mimeType: string
  sizeBytes: number
  completedAt: string
  lastAccessedAt: string
}

export type CachedLinkedResource = {
  file: Blob
  metadata: DriveResourceMetadata
  principalKey: string
  source: 'opfs' | 'memory'
  cacheKey?: string
}

export interface LinkedResourceCacheIndex {
  get(key: string): Promise<LinkedResourceCacheRecord | undefined>
  put(record: LinkedResourceCacheRecord): Promise<unknown>
  remove(key: string): Promise<void>
  list(): Promise<LinkedResourceCacheRecord[]>
}

export class LinkedResourceCacheDatabase
  extends Dexie
  implements LinkedResourceCacheIndex
{
  records!: Table<LinkedResourceCacheRecord, string>

  constructor(name = 'runme-linked-resource-cache') {
    super(name)
    this.version(1).stores({
      records: '&key, principalKey, sourceUri, versionKey, lastAccessedAt',
    })
    this.records = this.table('records')
  }

  get(key: string) {
    return this.records.get(key)
  }

  put(record: LinkedResourceCacheRecord) {
    return this.records.put(record)
  }

  async remove(key: string) {
    await this.records.delete(key)
  }

  list() {
    return this.records.toArray()
  }
}

export class MemoryLinkedResourceCacheIndex
  implements LinkedResourceCacheIndex
{
  private readonly records = new Map<string, LinkedResourceCacheRecord>()

  async get(key: string) {
    return this.records.get(key)
  }

  async put(record: LinkedResourceCacheRecord) {
    this.records.set(record.key, { ...record })
    return record.key
  }

  async remove(key: string) {
    this.records.delete(key)
  }

  async list() {
    return [...this.records.values()].map((record) => ({ ...record }))
  }
}

type StorageManagerWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>
}

type NavigatorWithLocks = Navigator & {
  locks?: {
    request<T>(name: string, callback: () => Promise<T>): Promise<T>
  }
}

export type LinkedResourceCacheOptions = {
  index?: LinkedResourceCacheIndex
  storage?: StorageManagerWithOpfs | null
  now?: () => Date
  randomId?: () => string
  quotaFraction?: number
  maxInMemoryBytes?: number
}

function defaultStorage(): StorageManagerWithOpfs | null {
  return (
    (globalThis.navigator?.storage as StorageManagerWithOpfs | undefined) ??
    null
  )
}

function encodePathSegment(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new LinkedResourceError('CACHE_CORRUPT', `${label} is invalid`)
  }
  return encodeURIComponent(normalized)
}

export function linkedResourceVersionKey(
  metadata: DriveResourceMetadata
): string {
  const value =
    metadata.md5Checksum ||
    metadata.headRevisionId ||
    (metadata.modifiedTime && metadata.sizeBytes !== undefined
      ? `${metadata.modifiedTime}-${metadata.sizeBytes}`
      : undefined)
  if (!value) {
    throw new LinkedResourceError(
      'RESOURCE_CHANGED',
      'Google Drive did not provide a stable resource version'
    )
  }
  return value
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new LinkedResourceError(
      'OPFS_UNAVAILABLE',
      'Secure hashing is unavailable for the Drive cache namespace'
    )
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
}

export async function linkedResourcePrincipalKey(
  permissionId: string
): Promise<string> {
  const normalized = permissionId.trim()
  if (!normalized) {
    throw new LinkedResourceError(
      'AUTH_REQUIRED',
      'Google Drive principal identifier is missing'
    )
  }
  return sha256(normalized)
}

async function getDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
  options: FileSystemGetDirectoryOptions = {}
): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, options)
  }
  return current
}

async function resolveFile(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemFileHandle> {
  const segments = path.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new LinkedResourceError('CACHE_CORRUPT', 'Cache path is invalid')
  }
  const directory = await getDirectory(root, segments.slice(0, -1))
  return directory.getFileHandle(segments.at(-1) ?? '')
}

async function removeFile(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<void> {
  const segments = path.split('/').filter(Boolean)
  const directory = await getDirectory(root, segments.slice(0, -1))
  await directory.removeEntry(segments.at(-1) ?? '').catch(() => {})
}

function asTypedBlob(file: File, mimeType: string): Blob {
  return file.type === mimeType ? file : new Blob([file], { type: mimeType })
}

export class LinkedResourceCache {
  private readonly index: LinkedResourceCacheIndex
  private readonly storage: StorageManagerWithOpfs | null
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly quotaFraction: number
  private readonly maxInMemoryBytes: number
  private readonly pinned = new Set<string>()

  constructor(options: LinkedResourceCacheOptions = {}) {
    this.index = options.index ?? new LinkedResourceCacheDatabase()
    this.storage =
      options.storage === undefined ? defaultStorage() : options.storage
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? (() => crypto.randomUUID())
    this.quotaFraction = options.quotaFraction ?? DEFAULT_CACHE_QUOTA_FRACTION
    this.maxInMemoryBytes =
      options.maxInMemoryBytes ?? MAX_IN_MEMORY_MEDIA_BYTES
  }

  pin(key: string): () => void {
    this.pinned.add(key)
    return () => this.pinned.delete(key)
  }

  async load(
    store: DriveResourceStore,
    metadata: DriveResourceMetadata,
    options: {
      signal?: AbortSignal
      onProgress?: (downloadedBytes: number, totalBytes?: number) => void
    } = {}
  ): Promise<CachedLinkedResource> {
    if (!metadata.canDownload) {
      throw new LinkedResourceError(
        'DOWNLOAD_RESTRICTED',
        'The current Google Drive user cannot download this file'
      )
    }
    const principal = await store.getPrincipal()
    const principalKey = await linkedResourcePrincipalKey(
      principal.permissionId
    )
    const versionKey = linkedResourceVersionKey(metadata)
    const fileId = parseGoogleDriveFileId(metadata.uri)
    const cacheKey = ['google-drive', principalKey, fileId, versionKey].join(
      ':'
    )

    if (!this.storage?.getDirectory) {
      return this.loadInMemory(store, metadata, principalKey, options)
    }

    const operation = () =>
      this.loadWithOpfs(
        store,
        metadata,
        principalKey,
        versionKey,
        fileId,
        cacheKey,
        options
      )
    const locks = (globalThis.navigator as NavigatorWithLocks | undefined)
      ?.locks
    return locks?.request
      ? locks.request(`runme-resource:${cacheKey}`, operation)
      : operation()
  }

  private async loadWithOpfs(
    store: DriveResourceStore,
    metadata: DriveResourceMetadata,
    principalKey: string,
    versionKey: string,
    fileId: string,
    cacheKey: string,
    options: {
      signal?: AbortSignal
      onProgress?: (downloadedBytes: number, totalBytes?: number) => void
    }
  ): Promise<CachedLinkedResource> {
    const root = await this.storage!.getDirectory!()
    const cached = await this.index.get(cacheKey)
    if (cached) {
      try {
        const handle = await resolveFile(root, cached.opfsPath)
        const file = await handle.getFile()
        if (file.size === cached.sizeBytes) {
          cached.lastAccessedAt = this.now().toISOString()
          await this.index.put(cached)
          return {
            file: asTypedBlob(file, cached.mimeType),
            metadata,
            principalKey,
            source: 'opfs',
            cacheKey,
          }
        }
      } catch {
        // A missing or mismatched OPFS payload invalidates its commit marker.
      }
      await this.index.remove(cacheKey)
      await removeFile(root, cached.opfsPath).catch(() => {})
    }

    await this.ensureCapacity(metadata.sizeBytes ?? 0, root)
    const encodedPrincipal = encodePathSegment(principalKey, 'principal key')
    const encodedFile = encodePathSegment(fileId, 'file id')
    const encodedVersion = encodePathSegment(versionKey, 'version key')
    const fileName = `content-${encodePathSegment(this.randomId(), 'download id')}`
    const pathSegments = [
      ...CACHE_ROOT_SEGMENTS,
      encodedPrincipal,
      encodedFile,
      encodedVersion,
      fileName,
    ]
    const opfsPath = pathSegments.join('/')
    const directory = await getDirectory(root, pathSegments.slice(0, -1), {
      create: true,
    })
    const handle = await directory.getFileHandle(fileName, { create: true })
    let writable: FileSystemWritableFileStream | null = null
    try {
      const response = await store.fetch(metadata.uri, {
        signal: options.signal,
      })
      const totalBytes =
        Number(response.headers.get('Content-Length')) || metadata.sizeBytes
      if (!response.body) {
        throw new LinkedResourceError(
          'DOWNLOAD_INTERRUPTED',
          'Google Drive returned an empty download stream'
        )
      }
      writable = await handle.createWritable()
      const reader = response.body.getReader()
      let downloadedBytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        if (options.signal?.aborted) {
          await reader.cancel()
          throw new LinkedResourceError(
            'DOWNLOAD_INTERRUPTED',
            'Resource download cancelled'
          )
        }
        await writable.write(value)
        downloadedBytes += value.byteLength
        options.onProgress?.(downloadedBytes, totalBytes)
      }
      await writable.close()
      writable = null
      const file = await handle.getFile()
      if (
        metadata.sizeBytes !== undefined &&
        file.size !== metadata.sizeBytes
      ) {
        throw new LinkedResourceError(
          'CACHE_CORRUPT',
          `Downloaded file size ${file.size} did not match ${metadata.sizeBytes}`
        )
      }
      const timestamp = this.now().toISOString()
      const record: LinkedResourceCacheRecord = {
        key: cacheKey,
        provider: 'google-drive',
        principalKey,
        sourceUri: metadata.uri,
        versionKey,
        opfsPath,
        mimeType: metadata.mimeType,
        sizeBytes: file.size,
        completedAt: timestamp,
        lastAccessedAt: timestamp,
      }
      await this.index.put(record)
      await ensurePersistentStorage(this.storage)
      return {
        file: asTypedBlob(file, metadata.mimeType),
        metadata,
        principalKey,
        source: 'opfs',
        cacheKey,
      }
    } catch (error) {
      await writable?.abort().catch(() => {})
      await removeFile(root, opfsPath).catch(() => {})
      if (error instanceof LinkedResourceError) {
        throw error
      }
      const code =
        error instanceof DOMException && error.name === 'QuotaExceededError'
          ? 'STORAGE_QUOTA_EXCEEDED'
          : 'DOWNLOAD_INTERRUPTED'
      throw new LinkedResourceError(code, 'Resource download failed', {
        cause: error,
      })
    }
  }

  private async loadInMemory(
    store: DriveResourceStore,
    metadata: DriveResourceMetadata,
    principalKey: string,
    options: {
      signal?: AbortSignal
      onProgress?: (downloadedBytes: number, totalBytes?: number) => void
    }
  ): Promise<CachedLinkedResource> {
    if (
      metadata.sizeBytes !== undefined &&
      metadata.sizeBytes > this.maxInMemoryBytes
    ) {
      throw new LinkedResourceError(
        'MEDIA_TOO_LARGE_FOR_FALLBACK',
        'This resource is too large to load without OPFS'
      )
    }
    const response = await store.fetch(metadata.uri, { signal: options.signal })
    const blob = await response.blob()
    if (blob.size > this.maxInMemoryBytes) {
      throw new LinkedResourceError(
        'MEDIA_TOO_LARGE_FOR_FALLBACK',
        'This resource is too large to load without OPFS'
      )
    }
    options.onProgress?.(blob.size, blob.size)
    return {
      file:
        blob.type === metadata.mimeType
          ? blob
          : new Blob([blob], { type: metadata.mimeType }),
      metadata,
      principalKey,
      source: 'memory',
    }
  }

  private async ensureCapacity(
    incomingBytes: number,
    root: FileSystemDirectoryHandle
  ): Promise<void> {
    const estimate = await this.storage?.estimate?.().catch(() => undefined)
    const quota = estimate?.quota
    const usage = estimate?.usage ?? 0
    if (!quota || incomingBytes <= 0) {
      return
    }
    const budget = quota * this.quotaFraction
    if (incomingBytes > budget) {
      throw new LinkedResourceError(
        'STORAGE_QUOTA_EXCEEDED',
        'Resource exceeds the linked-media cache budget'
      )
    }
    let required = usage + incomingBytes - budget
    if (required <= 0) {
      return
    }
    const candidates = (await this.index.list())
      .filter((record) => !this.pinned.has(record.key))
      .sort((left, right) =>
        left.lastAccessedAt.localeCompare(right.lastAccessedAt)
      )
    for (const record of candidates) {
      await removeFile(root, record.opfsPath).catch(() => {})
      await this.index.remove(record.key)
      required -= record.sizeBytes
      if (required <= 0) {
        return
      }
    }
    throw new LinkedResourceError(
      'STORAGE_QUOTA_EXCEEDED',
      'Not enough browser storage is available for this resource'
    )
  }

  async clear(): Promise<number> {
    const records = await this.index.list()
    let freed = 0
    const root = this.storage?.getDirectory
      ? await this.storage.getDirectory().catch(() => null)
      : null
    for (const record of records) {
      if (root) {
        await removeFile(root, record.opfsPath).catch(() => {})
      }
      await this.index.remove(record.key)
      freed += record.sizeBytes
    }
    return freed
  }
}

let defaultCache: LinkedResourceCache | null = null

export function getLinkedResourceCache(): LinkedResourceCache {
  defaultCache ??= new LinkedResourceCache()
  return defaultCache
}
