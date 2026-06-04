import md5 from 'md5'

export interface ConflictDocumentRef {
  storage: 'opfs'
  path: string
  sizeBytes: number
  checksum: string
}

export interface ConflictDocStorage {
  write(localUri: string, upstreamDoc: string): Promise<ConflictDocumentRef>
  read(ref: ConflictDocumentRef): Promise<string>
  delete(ref: ConflictDocumentRef): Promise<void>
}

const ROOT_DIR = 'runme'
const CONFLICT_DIR = 'conflicts'
const UPSTREAM_DOC_FILE = 'upstream.json'

const textEncoder = new TextEncoder()

function conflictPathForLocalUri(localUri: string): string {
  return [
    ROOT_DIR,
    CONFLICT_DIR,
    encodeURIComponent(localUri),
    UPSTREAM_DOC_FILE,
  ].join('/')
}

function opfsUnavailableError(): Error {
  return new Error('Origin private file system is not available')
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = globalThis.navigator?.storage
  if (!storage?.getDirectory) {
    throw opfsUnavailableError()
  }
  return storage.getDirectory()
}

async function getDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
  options: FileSystemGetDirectoryOptions = {}
): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, options)
  }
  return dir
}

export class OpfsConflictDocStorage implements ConflictDocStorage {
  async write(
    localUri: string,
    upstreamDoc: string
  ): Promise<ConflictDocumentRef> {
    const path = conflictPathForLocalUri(localUri)
    const root = await getOpfsRoot()
    const dir = await getDirectory(
      root,
      [ROOT_DIR, CONFLICT_DIR, encodeURIComponent(localUri)],
      { create: true }
    )
    const handle = await dir.getFileHandle(UPSTREAM_DOC_FILE, {
      create: true,
    })
    const writable = await handle.createWritable()
    await writable.write(upstreamDoc)
    await writable.close()

    return {
      storage: 'opfs',
      path,
      sizeBytes: textEncoder.encode(upstreamDoc).byteLength,
      checksum: md5(upstreamDoc),
    }
  }

  async read(ref: ConflictDocumentRef): Promise<string> {
    if (ref.storage !== 'opfs') {
      throw new Error(`Unsupported conflict document storage: ${ref.storage}`)
    }
    const segments = ref.path.split('/').filter(Boolean)
    if (segments.length < 2) {
      throw new Error(`Invalid conflict document path: ${ref.path}`)
    }
    const root = await getOpfsRoot()
    const dir = await getDirectory(root, segments.slice(0, -1))
    const handle = await dir.getFileHandle(segments[segments.length - 1])
    const file = await handle.getFile()
    return file.text()
  }

  async delete(ref: ConflictDocumentRef): Promise<void> {
    if (ref.storage !== 'opfs') {
      return
    }
    const segments = ref.path.split('/').filter(Boolean)
    if (segments.length < 2) {
      return
    }
    const root = await getOpfsRoot()
    const dir = await getDirectory(root, segments.slice(0, -1))
    await dir.removeEntry(segments[segments.length - 1]).catch(() => {})
  }
}

export class MemoryConflictDocStorage implements ConflictDocStorage {
  private readonly docs = new Map<string, string>()

  async write(
    localUri: string,
    upstreamDoc: string
  ): Promise<ConflictDocumentRef> {
    const path = conflictPathForLocalUri(localUri)
    this.docs.set(path, upstreamDoc)
    return {
      storage: 'opfs',
      path,
      sizeBytes: textEncoder.encode(upstreamDoc).byteLength,
      checksum: md5(upstreamDoc),
    }
  }

  async read(ref: ConflictDocumentRef): Promise<string> {
    const doc = this.docs.get(ref.path)
    if (doc === undefined) {
      throw new Error(`Conflict document not found: ${ref.path}`)
    }
    return doc
  }

  async delete(ref: ConflictDocumentRef): Promise<void> {
    this.docs.delete(ref.path)
  }
}

export function createDefaultConflictDocStorage(): ConflictDocStorage {
  return new OpfsConflictDocStorage()
}
