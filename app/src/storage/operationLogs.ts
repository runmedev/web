import md5 from 'md5'

export interface OperationLogRef {
  storage: 'opfs'
  path: string
}

export interface OperationLogSnapshot {
  ref: OperationLogRef
  document: string
  sizeBytes: number
  checksum: string
}

export interface OperationLogStorage {
  initialize(
    canonicalUri: string,
    document: string
  ): Promise<OperationLogSnapshot>
  read(ref: OperationLogRef): Promise<OperationLogSnapshot>
  append(
    ref: OperationLogRef,
    records: string,
    options?: { validate?: (document: string) => void }
  ): Promise<OperationLogSnapshot>
  replace(
    ref: OperationLogRef,
    document: string,
    options?: { expectedChecksum?: string }
  ): Promise<OperationLogSnapshot>
  delete(ref: OperationLogRef): Promise<void>
}

export class OperationLogChangedError extends Error {
  constructor(readonly path: string) {
    super(`Operation log changed before replacement: ${path}`)
    this.name = 'OperationLogChangedError'
  }
}

export interface OperationLogCoordinator {
  runExclusive<T>(path: string, operation: () => Promise<T>): Promise<T>
}

const ROOT_DIR = 'runme'
const LOG_DIR = 'notebooks'
const LOG_FILE = 'document.runme'
const LOCK_PREFIX = 'runme:operation-log:'
const textEncoder = new TextEncoder()
const fallbackTails = new Map<string, Promise<void>>()

function hasWebLocks(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function'
  )
}

async function runInProcessExclusive<T>(
  lockName: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fallbackTails.get(lockName) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  fallbackTails.set(lockName, tail)

  await previous
  try {
    return await operation()
  } finally {
    release()
    if (fallbackTails.get(lockName) === tail) {
      fallbackTails.delete(lockName)
    }
  }
}

/** Serialize one short physical operation-log mutation across same-origin tabs. */
export const browserOperationLogCoordinator: OperationLogCoordinator = {
  async runExclusive<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const lockName = `${LOCK_PREFIX}${path}`
    if (!hasWebLocks()) {
      return runInProcessExclusive(lockName, operation)
    }
    return navigator.locks.request(lockName, operation)
  },
}

export function operationLogPath(canonicalUri: string): string {
  if (!canonicalUri) {
    throw new Error('Operation-log path requires a canonical notebook URI')
  }
  return [ROOT_DIR, LOG_DIR, encodeURIComponent(canonicalUri), LOG_FILE].join(
    '/'
  )
}

function validateFraming(document: string, label: string): void {
  if (!document || !document.endsWith('\n')) {
    throw new Error(`${label} must be non-empty and end with LF`)
  }
  if (
    document
      .slice(0, -1)
      .split('\n')
      .some((line) => line.trim() === '')
  ) {
    throw new Error(`${label} must not contain blank records`)
  }
}

function snapshot(
  ref: OperationLogRef,
  document: string
): OperationLogSnapshot {
  return {
    ref,
    document,
    sizeBytes: textEncoder.encode(document).byteLength,
    checksum: md5(document),
  }
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

async function getHandle(
  ref: OperationLogRef,
  create = false
): Promise<FileSystemFileHandle> {
  const segments = ref.path.split('/').filter(Boolean)
  const root = await getOpfsRoot()
  const directory = await getDirectory(root, segments.slice(0, -1), {
    create,
  })
  return directory.getFileHandle(segments.at(-1)!, { create })
}

/** Store the authoritative append-only .runme document in browser OPFS. */
export class OpfsOperationLogStorage implements OperationLogStorage {
  constructor(
    private readonly coordinator: OperationLogCoordinator = browserOperationLogCoordinator
  ) {}

  async initialize(
    canonicalUri: string,
    document: string
  ): Promise<OperationLogSnapshot> {
    validateFraming(document, 'Initial operation log')
    const ref: OperationLogRef = {
      storage: 'opfs',
      path: operationLogPath(canonicalUri),
    }
    return this.coordinator.runExclusive(ref.path, async () => {
      const handle = await getHandle(ref, true)
      const current = await handle.getFile()
      if (current.size > 0) {
        const currentDocument = await current.text()
        if (currentDocument !== document) {
          throw new Error(`Operation log already exists: ${ref.path}`)
        }
        return snapshot(ref, currentDocument)
      }
      const writable = await handle.createWritable()
      await writable.write(document)
      await writable.close()
      return this.readUnchecked(ref)
    })
  }

  private async readUnchecked(
    ref: OperationLogRef
  ): Promise<OperationLogSnapshot> {
    if (ref.storage !== 'opfs') {
      throw new Error(`Unsupported operation-log storage: ${ref.storage}`)
    }
    const document = await (await getHandle(ref))
      .getFile()
      .then((file) => file.text())
    validateFraming(document, 'Stored operation log')
    return snapshot(ref, document)
  }

  async read(ref: OperationLogRef): Promise<OperationLogSnapshot> {
    return this.readUnchecked(ref)
  }

  async append(
    ref: OperationLogRef,
    records: string,
    options: { validate?: (document: string) => void } = {}
  ): Promise<OperationLogSnapshot> {
    validateFraming(records, 'Appended operation-log records')
    return this.coordinator.runExclusive(ref.path, async () => {
      const handle = await getHandle(ref)
      const file = await handle.getFile()
      const current = await file.text()
      options.validate?.(`${current}${records}`)
      const writable = await handle.createWritable({ keepExistingData: true })
      await writable.seek(file.size)
      await writable.write(records)
      await writable.close()
      return this.readUnchecked(ref)
    })
  }

  async replace(
    ref: OperationLogRef,
    document: string,
    options: { expectedChecksum?: string } = {}
  ): Promise<OperationLogSnapshot> {
    validateFraming(document, 'Replacement operation log')
    return this.coordinator.runExclusive(ref.path, async () => {
      const handle = await getHandle(ref)
      if (options.expectedChecksum) {
        const current = await (await handle.getFile()).text()
        if (md5(current) !== options.expectedChecksum) {
          throw new OperationLogChangedError(ref.path)
        }
      }
      const writable = await handle.createWritable()
      await writable.write(document)
      await writable.close()
      return this.readUnchecked(ref)
    })
  }

  async delete(ref: OperationLogRef): Promise<void> {
    await this.coordinator.runExclusive(ref.path, async () => {
      const segments = ref.path.split('/').filter(Boolean)
      if (segments.length < 2) return
      const root = await getOpfsRoot()
      const directory = await getDirectory(root, segments.slice(0, -1))
      await directory.removeEntry(segments.at(-1)!).catch(() => {})
    })
  }
}

/** In-memory operation-log storage used by deterministic unit tests. */
export class MemoryOperationLogStorage implements OperationLogStorage {
  constructor(
    private readonly documents = new Map<string, string>(),
    private readonly coordinator: OperationLogCoordinator = browserOperationLogCoordinator
  ) {}

  async initialize(
    canonicalUri: string,
    document: string
  ): Promise<OperationLogSnapshot> {
    validateFraming(document, 'Initial operation log')
    const ref: OperationLogRef = {
      storage: 'opfs',
      path: operationLogPath(canonicalUri),
    }
    return this.coordinator.runExclusive(ref.path, async () => {
      const current = this.documents.get(ref.path)
      if (current !== undefined && current !== document) {
        throw new Error(`Operation log already exists: ${ref.path}`)
      }
      this.documents.set(ref.path, document)
      return snapshot(ref, document)
    })
  }

  async read(ref: OperationLogRef): Promise<OperationLogSnapshot> {
    const document = this.documents.get(ref.path)
    if (document === undefined) {
      throw new Error(`Operation log not found: ${ref.path}`)
    }
    validateFraming(document, 'Stored operation log')
    return snapshot(ref, document)
  }

  async append(
    ref: OperationLogRef,
    records: string,
    options: { validate?: (document: string) => void } = {}
  ): Promise<OperationLogSnapshot> {
    validateFraming(records, 'Appended operation-log records')
    return this.coordinator.runExclusive(ref.path, async () => {
      const current = this.documents.get(ref.path)
      if (current === undefined) {
        throw new Error(`Operation log not found: ${ref.path}`)
      }
      const document = `${current}${records}`
      options.validate?.(document)
      this.documents.set(ref.path, document)
      return snapshot(ref, document)
    })
  }

  async replace(
    ref: OperationLogRef,
    document: string,
    options: { expectedChecksum?: string } = {}
  ): Promise<OperationLogSnapshot> {
    validateFraming(document, 'Replacement operation log')
    return this.coordinator.runExclusive(ref.path, async () => {
      if (!this.documents.has(ref.path)) {
        throw new Error(`Operation log not found: ${ref.path}`)
      }
      if (
        options.expectedChecksum &&
        md5(this.documents.get(ref.path)!) !== options.expectedChecksum
      ) {
        throw new OperationLogChangedError(ref.path)
      }
      this.documents.set(ref.path, document)
      return snapshot(ref, document)
    })
  }

  async delete(ref: OperationLogRef): Promise<void> {
    await this.coordinator.runExclusive(ref.path, async () => {
      this.documents.delete(ref.path)
    })
  }
}

export function createDefaultOperationLogStorage(): OperationLogStorage {
  return new OpfsOperationLogStorage()
}
