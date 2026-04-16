export type AppKernelOpfsApi = {
  exists(path: string): Promise<boolean>
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  readBytes(path: string): Promise<Uint8Array>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  list(
    path: string
  ): Promise<Array<{ name: string; kind: 'file' | 'directory' }>>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  stat(
    path: string
  ): Promise<{ kind: 'file' | 'directory'; size?: number; mtime?: string }>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
}

export type AppKernelNetworkApi = {
  get(
    url: string,
    options?: {
      headers?: Record<string, string>
      responseType?: 'text' | 'bytes' | 'json'
    }
  ): Promise<{
    ok: boolean
    status: number
    headers: Record<string, string>
    text?: string
    bytes?: Uint8Array
    json?: unknown
  }>
}

function normalizePath(path: string): string[] {
  const value = String(path ?? '').trim()
  if (value === '' || value === '/') {
    return []
  }

  const segments = value
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid OPFS path: ${path}`)
  }

  return segments
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: unknown }).name === 'NotFoundError'
}

async function getNativeOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage
  if (!storage || typeof storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available in this browser.')
  }
  return storage.getDirectory()
}

async function getDirectoryHandle(
  root: FileSystemDirectoryHandle,
  segments: string[],
  options?: { create?: boolean }
): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const segment of segments) {
    if (typeof current.getDirectoryHandle !== 'function') {
      throw new Error('OPFS directory access is not available.')
    }
    current = await current.getDirectoryHandle(segment, {
      create: options?.create === true,
    })
  }
  return current
}

async function tryGetDirectoryHandle(
  root: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await getDirectoryHandle(root, segments)
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

async function tryGetFileHandle(
  root: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemFileHandle | null> {
  if (segments.length === 0) {
    return null
  }

  const parent = await tryGetDirectoryHandle(root, segments.slice(0, -1))
  if (!parent || typeof parent.getFileHandle !== 'function') {
    return null
  }

  try {
    return await parent.getFileHandle(segments.at(-1) ?? '')
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

async function getOrCreateParentDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemDirectoryHandle> {
  return getDirectoryHandle(root, segments.slice(0, -1), { create: true })
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

export function createAppKernelOpfsApi(options?: {
  getRootDirectory?: () => Promise<FileSystemDirectoryHandle>
}): AppKernelOpfsApi {
  const getRootDirectory = options?.getRootDirectory ?? getNativeOpfsRoot

  return {
    async exists(path) {
      const segments = normalizePath(path)
      if (segments.length === 0) {
        return true
      }

      const root = await getRootDirectory()
      if (await tryGetDirectoryHandle(root, segments)) {
        return true
      }
      return (await tryGetFileHandle(root, segments)) !== null
    },

    async readText(path) {
      const segments = normalizePath(path)
      const root = await getRootDirectory()
      const handle = await tryGetFileHandle(root, segments)
      if (!handle || typeof handle.getFile !== 'function') {
        throw new Error(`OPFS file not found: ${path}`)
      }
      const file = await handle.getFile()
      return file.text()
    },

    async writeText(path, text) {
      const segments = normalizePath(path)
      if (segments.length === 0) {
        throw new Error('Cannot write to the OPFS root.')
      }
      const root = await getRootDirectory()
      const parent = await getOrCreateParentDirectory(root, segments)
      if (typeof parent.getFileHandle !== 'function') {
        throw new Error('OPFS file access is not available.')
      }
      const handle = await parent.getFileHandle(segments.at(-1) ?? '', {
        create: true,
      })
      if (typeof handle.createWritable !== 'function') {
        throw new Error('OPFS writable file access is not available.')
      }
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
    },

    async readBytes(path) {
      const segments = normalizePath(path)
      const root = await getRootDirectory()
      const handle = await tryGetFileHandle(root, segments)
      if (!handle || typeof handle.getFile !== 'function') {
        throw new Error(`OPFS file not found: ${path}`)
      }
      const file = await handle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    },

    async writeBytes(path, bytes) {
      const segments = normalizePath(path)
      if (segments.length === 0) {
        throw new Error('Cannot write to the OPFS root.')
      }
      const root = await getRootDirectory()
      const parent = await getOrCreateParentDirectory(root, segments)
      if (typeof parent.getFileHandle !== 'function') {
        throw new Error('OPFS file access is not available.')
      }
      const handle = await parent.getFileHandle(segments.at(-1) ?? '', {
        create: true,
      })
      if (typeof handle.createWritable !== 'function') {
        throw new Error('OPFS writable file access is not available.')
      }
      const writable = await handle.createWritable()
      await writable.write(bytes)
      await writable.close()
    },

    async list(path) {
      const segments = normalizePath(path)
      const root = await getRootDirectory()
      const directory = await getDirectoryHandle(root, segments)
      if (typeof directory.entries !== 'function') {
        throw new Error('OPFS directory iteration is not available.')
      }

      const items: Array<{ name: string; kind: 'file' | 'directory' }> = []
      for await (const [name, handle] of directory.entries()) {
        const kind = (handle as { kind?: 'file' | 'directory' }).kind ?? 'file'
        items.push({ name, kind })
      }
      items.sort((left, right) => left.name.localeCompare(right.name))
      return items
    },

    async mkdir(path, options) {
      const segments = normalizePath(path)
      if (segments.length === 0) {
        return
      }

      const root = await getRootDirectory()
      if (options?.recursive === true) {
        await getDirectoryHandle(root, segments, { create: true })
        return
      }

      const parent = await getDirectoryHandle(root, segments.slice(0, -1))
      if (typeof parent.getDirectoryHandle !== 'function') {
        throw new Error('OPFS directory access is not available.')
      }
      await parent.getDirectoryHandle(segments.at(-1) ?? '', { create: true })
    },

    async stat(path) {
      const segments = normalizePath(path)
      const root = await getRootDirectory()
      if (segments.length === 0) {
        return { kind: 'directory' }
      }

      const fileHandle = await tryGetFileHandle(root, segments)
      if (fileHandle && typeof fileHandle.getFile === 'function') {
        const file = await fileHandle.getFile()
        return {
          kind: 'file',
          size: file.size,
          mtime: new Date(file.lastModified).toISOString(),
        }
      }

      const directoryHandle = await tryGetDirectoryHandle(root, segments)
      if (directoryHandle) {
        return { kind: 'directory' }
      }

      throw new Error(`OPFS path not found: ${path}`)
    },

    async remove(path, options) {
      const segments = normalizePath(path)
      if (segments.length === 0) {
        throw new Error('Cannot remove the OPFS root.')
      }

      const root = await getRootDirectory()
      const parent = await getDirectoryHandle(root, segments.slice(0, -1))
      if (typeof parent.removeEntry !== 'function') {
        throw new Error('OPFS removeEntry is not available.')
      }
      await parent.removeEntry(segments.at(-1) ?? '', {
        recursive: options?.recursive === true,
      })
    },
  }
}

export function createAppKernelNetworkApi(options?: {
  fetchImpl?: typeof fetch
}): AppKernelNetworkApi {
  const fetchImpl = options?.fetchImpl ?? fetch

  return {
    async get(url, requestOptions) {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: requestOptions?.headers,
      })
      const headers = headersToObject(response.headers)
      const result: {
        ok: boolean
        status: number
        headers: Record<string, string>
        text?: string
        bytes?: Uint8Array
        json?: unknown
      } = {
        ok: response.ok,
        status: response.status,
        headers,
      }

      switch (requestOptions?.responseType ?? 'text') {
        case 'bytes':
          result.bytes = new Uint8Array(await response.arrayBuffer())
          break
        case 'json':
          result.json = await response.json()
          break
        case 'text':
        default:
          result.text = await response.text()
          break
      }

      return result
    },
  }
}
