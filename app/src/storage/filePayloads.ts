/** Native hashing avoids the MD5 package's byte-per-number JavaScript arrays. */
export async function filePayloadChecksum(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

/** Immutable content; IndexedDB commits only this small locator after durable close. */
export interface FilePayloadRef {
  storage: 'opfs'
  path: string
  sizeBytes: number
  checksum: string
}
export interface FilePayloadStorage {
  write(content: string): Promise<FilePayloadRef>
  read(ref: FilePayloadRef): Promise<string>
  protect?(ref: FilePayloadRef): void
  collectUnreferenced?(): Promise<void>
}

/** Separate payload generations prevent an interrupted write from damaging live content. */
export class OpfsFilePayloadStorage implements FilePayloadStorage {
  // Reads and writes protect references for this worker's lifetime. Startup
  // collection can therefore run alongside saves without deleting an in-flight
  // payload or a reference captured before an asynchronous operation resumes.
  private readonly protectedPaths = new Set<string>()

  protect(ref: FilePayloadRef): void {
    this.protectedPaths.add(ref.path)
  }

  private async directory(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory()
    const runme = await root.getDirectoryHandle('runme', { create: true })
    return runme.getDirectoryHandle('file-payloads', { create: true })
  }
  async write(content: string): Promise<FilePayloadRef> {
    const name = `${crypto.randomUUID()}.json`
    const path = `runme/file-payloads/${name}`
    this.protectedPaths.add(path)
    const directory = await this.directory()
    const file = await directory.getFileHandle(name, { create: true })
    const writable = await file.createWritable()
    try {
      await writable.write(content)
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
    return {
      storage: 'opfs',
      path,
      sizeBytes: (await file.getFile()).size,
      checksum: await filePayloadChecksum(content),
    }
  }
  async read(ref: FilePayloadRef): Promise<string> {
    this.protect(ref)
    if (!/^runme\/file-payloads\/[\w-]+\.json$/.test(ref.path))
      throw new Error('Invalid notebook payload reference')
    const file = await (
      await this.directory()
    ).getFileHandle(ref.path.split('/').at(-1)!)
    const blob = await file.getFile()
    if (blob.size !== ref.sizeBytes)
      throw new Error(`Notebook payload size mismatch: ${ref.path}`)
    const content = await blob.text()
    if ((await filePayloadChecksum(content)) !== ref.checksum)
      throw new Error(`Notebook payload checksum mismatch: ${ref.path}`)
    return content
  }

  /** Call only after visiting all durable references; walk directory entries lazily. */
  async collectUnreferenced(): Promise<void> {
    const directory = await this.directory()
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file' || !/^[\w-]+\.json$/.test(name)) continue
      if (!this.protectedPaths.has(`runme/file-payloads/${name}`)) {
        await directory.removeEntry(name)
      }
    }
  }
}

/** Explicit unit-test storage; production never falls back to volatile content. */
export class MemoryFilePayloadStorage implements FilePayloadStorage {
  readonly values = new Map<string, string>()
  async write(content: string): Promise<FilePayloadRef> {
    const path = `runme/file-payloads/${crypto.randomUUID()}.json`
    this.values.set(path, content)
    return {
      storage: 'opfs',
      path,
      sizeBytes: new Blob([content]).size,
      checksum: await filePayloadChecksum(content),
    }
  }
  async read(ref: FilePayloadRef): Promise<string> {
    const content = this.values.get(ref.path)
    if (
      content === undefined ||
      (await filePayloadChecksum(content)) !== ref.checksum
    )
      throw new Error(`Notebook payload missing or corrupt: ${ref.path}`)
    return content
  }
}
