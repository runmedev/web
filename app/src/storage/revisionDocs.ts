import md5 from 'md5'

export interface RevisionDocumentRef {
  storage: 'opfs'
  path: string
  revisionId: string
  sizeBytes: number
  checksum: string
}

export interface RevisionDocStorage {
  write(
    localUri: string,
    revisionId: string,
    revisionDoc: string
  ): Promise<RevisionDocumentRef>
  read(localUri: string, revisionId: string): Promise<string>
  delete(localUri: string, revisionId: string): Promise<void>
}

const ROOT_DIR = 'runme'
const REVISION_DIR = 'revisions'
const REVISION_DOC_FILE = 'revision.json'

const textEncoder = new TextEncoder()

function normalizeRevisionId(revisionId: string): string {
  const normalized = revisionId.trim()
  if (!normalized) {
    throw new Error('Drive revision id is required')
  }
  return normalized
}

function revisionPathForLocalUri(localUri: string, revisionId: string): string {
  return [
    ROOT_DIR,
    REVISION_DIR,
    encodeURIComponent(localUri),
    encodeURIComponent(normalizeRevisionId(revisionId)),
    REVISION_DOC_FILE,
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

export class OpfsRevisionDocStorage implements RevisionDocStorage {
  async write(
    localUri: string,
    revisionId: string,
    revisionDoc: string
  ): Promise<RevisionDocumentRef> {
    const normalizedRevisionId = normalizeRevisionId(revisionId)
    const path = revisionPathForLocalUri(localUri, normalizedRevisionId)
    const root = await getOpfsRoot()
    const dir = await getDirectory(
      root,
      [
        ROOT_DIR,
        REVISION_DIR,
        encodeURIComponent(localUri),
        encodeURIComponent(normalizedRevisionId),
      ],
      { create: true }
    )
    const handle = await dir.getFileHandle(REVISION_DOC_FILE, {
      create: true,
    })
    const writable = await handle.createWritable()
    await writable.write(revisionDoc)
    await writable.close()

    return {
      storage: 'opfs',
      path,
      revisionId: normalizedRevisionId,
      sizeBytes: textEncoder.encode(revisionDoc).byteLength,
      checksum: md5(revisionDoc),
    }
  }

  async read(localUri: string, revisionId: string): Promise<string> {
    const path = revisionPathForLocalUri(localUri, revisionId)
    const segments = path.split('/').filter(Boolean)
    const root = await getOpfsRoot()
    const dir = await getDirectory(root, segments.slice(0, -1))
    const handle = await dir.getFileHandle(segments[segments.length - 1])
    const file = await handle.getFile()
    return file.text()
  }

  async delete(localUri: string, revisionId: string): Promise<void> {
    const path = revisionPathForLocalUri(localUri, revisionId)
    const segments = path.split('/').filter(Boolean)
    const root = await getOpfsRoot()
    const dir = await getDirectory(root, segments.slice(0, -1))
    await dir.removeEntry(segments[segments.length - 1]).catch(() => {})
  }
}

export class MemoryRevisionDocStorage implements RevisionDocStorage {
  private readonly docs = new Map<string, string>()

  async write(
    localUri: string,
    revisionId: string,
    revisionDoc: string
  ): Promise<RevisionDocumentRef> {
    const normalizedRevisionId = normalizeRevisionId(revisionId)
    const path = revisionPathForLocalUri(localUri, normalizedRevisionId)
    this.docs.set(path, revisionDoc)
    return {
      storage: 'opfs',
      path,
      revisionId: normalizedRevisionId,
      sizeBytes: textEncoder.encode(revisionDoc).byteLength,
      checksum: md5(revisionDoc),
    }
  }

  async read(localUri: string, revisionId: string): Promise<string> {
    const path = revisionPathForLocalUri(localUri, revisionId)
    const doc = this.docs.get(path)
    if (doc === undefined) {
      throw new Error(`Revision document not found: ${path}`)
    }
    return doc
  }

  async delete(localUri: string, revisionId: string): Promise<void> {
    this.docs.delete(revisionPathForLocalUri(localUri, revisionId))
  }
}

export function createDefaultRevisionDocStorage(): RevisionDocStorage {
  return new OpfsRevisionDocStorage()
}
