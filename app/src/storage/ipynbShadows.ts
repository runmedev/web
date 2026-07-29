import md5 from 'md5'

export interface IpynbShadowRef {
  storage: 'opfs'
  path: string
  sizeBytes: number
  checksum: string
}

export interface IpynbPreservationState {
  upstreamFingerprint: string
  /**
   * Checksum of the Runme representation at the last successful upstream
   * read or write. This differs from the checksum of the raw .ipynb bytes.
   */
  baselineNotebookChecksum?: string
  shadowRef: IpynbShadowRef
  jupyterIdByRunmeRefId: Record<string, string>
  baselineCellHashes: Record<string, string>
  baselineOutputHashes: Record<string, string>
}

export interface IpynbShadowStorage {
  write(canonicalUri: string, document: string): Promise<IpynbShadowRef>
  read(ref: IpynbShadowRef): Promise<string>
  delete(ref: IpynbShadowRef): Promise<void>
}

const ROOT_DIR = 'runme'
const SHADOW_DIR = 'ipynb-shadows'
const textEncoder = new TextEncoder()

function pathFor(canonicalUri: string, document: string): string {
  return [
    ROOT_DIR,
    SHADOW_DIR,
    encodeURIComponent(canonicalUri),
    `${md5(document)}.ipynb`,
  ].join('/')
}

async function getDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
  options: FileSystemGetDirectoryOptions = {}
): Promise<FileSystemDirectoryHandle> {
  let directory = root
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, options)
  }
  return directory
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = globalThis.navigator?.storage
  if (!storage?.getDirectory) {
    throw new Error('Origin private file system is not available')
  }
  return storage.getDirectory()
}

function verify(ref: IpynbShadowRef, document: string): void {
  const sizeBytes = textEncoder.encode(document).byteLength
  const checksum = md5(document)
  if (sizeBytes !== ref.sizeBytes || checksum !== ref.checksum) {
    throw new Error(`IPYNB shadow checksum mismatch: ${ref.path}`)
  }
}

export class OpfsIpynbShadowStorage implements IpynbShadowStorage {
  async write(canonicalUri: string, document: string): Promise<IpynbShadowRef> {
    const path = pathFor(canonicalUri, document)
    const segments = path.split('/')
    const root = await getOpfsRoot()
    const directory = await getDirectory(root, segments.slice(0, -1), {
      create: true,
    })
    const handle = await directory.getFileHandle(segments.at(-1)!, {
      create: true,
    })
    const writable = await handle.createWritable()
    await writable.write(document)
    await writable.close()
    const ref = {
      storage: 'opfs' as const,
      path,
      sizeBytes: textEncoder.encode(document).byteLength,
      checksum: md5(document),
    }
    verify(ref, await this.readUnchecked(ref))
    return ref
  }

  private async readUnchecked(ref: IpynbShadowRef): Promise<string> {
    const segments = ref.path.split('/').filter(Boolean)
    const root = await getOpfsRoot()
    const directory = await getDirectory(root, segments.slice(0, -1))
    const handle = await directory.getFileHandle(segments.at(-1)!)
    return (await handle.getFile()).text()
  }

  async read(ref: IpynbShadowRef): Promise<string> {
    if (ref.storage !== 'opfs') {
      throw new Error(`Unsupported IPYNB shadow storage: ${ref.storage}`)
    }
    const document = await this.readUnchecked(ref)
    verify(ref, document)
    return document
  }

  async delete(ref: IpynbShadowRef): Promise<void> {
    const segments = ref.path.split('/').filter(Boolean)
    if (segments.length < 2) {
      return
    }
    const root = await getOpfsRoot()
    const directory = await getDirectory(root, segments.slice(0, -1))
    await directory.removeEntry(segments.at(-1)!).catch(() => {})
  }
}

export class MemoryIpynbShadowStorage implements IpynbShadowStorage {
  private readonly documents = new Map<string, string>()

  async write(canonicalUri: string, document: string): Promise<IpynbShadowRef> {
    const path = pathFor(canonicalUri, document)
    this.documents.set(path, document)
    return {
      storage: 'opfs',
      path,
      sizeBytes: textEncoder.encode(document).byteLength,
      checksum: md5(document),
    }
  }

  async read(ref: IpynbShadowRef): Promise<string> {
    const document = this.documents.get(ref.path)
    if (document === undefined) {
      throw new Error(`IPYNB shadow not found: ${ref.path}`)
    }
    verify(ref, document)
    return document
  }

  async delete(ref: IpynbShadowRef): Promise<void> {
    this.documents.delete(ref.path)
  }
}

export function createDefaultIpynbShadowStorage(): IpynbShadowStorage {
  return new OpfsIpynbShadowStorage()
}
