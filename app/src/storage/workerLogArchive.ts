import {
  type WorkerLogEvent,
  type WorkerLogQuery,
  pageWorkerLogs,
  workerLogBytes,
} from './workerLog'

const CHUNK_BYTES = 65536
const INSTANCE_BYTES = 2 * 1024 * 1024
const ORIGIN_BYTES = 20 * 1024 * 1024
const MAX_SCAN = 1024
const MAX_CHUNKS = 512
const MAX_INSTANCE_CHUNKS = 64
const MAX_AGE = 7 * 86400000
const ARCHIVE_LOCK = 'runme-worker-diagnostics-archive-v1'
const path = ['runme-diagnostics', 'storage-workers', 'v1']
const safeName = /^[a-zA-Z0-9_-]{1,200}$/
const chunkName = /^(\d+)-(\d+)\.jsonl$/

type Directory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}
type Chunk = {
  instanceId: string
  name: string
  first: number
  last: number
  size: number
  modified: number
  directory: Directory
  file: FileSystemFileHandle
}
type RootProvider = () => Promise<FileSystemDirectoryHandle>

/** Use only the diagnostics subtree. Reads never create directories or stores. */
async function directory(
  root: RootProvider,
  create: boolean,
  check = () => {}
): Promise<Directory> {
  check()
  let current = await root()
  check()
  for (const name of path) {
    current = await current.getDirectoryHandle(name, { create })
    // A native read can settle after its caller's deadline. Do not start the
    // next read in that case, or a second stall could retain the slot forever.
    check()
  }
  return current as Directory
}

/** Metadata enumeration is capped, including unexpected entries. */
async function scan(
  root: Directory,
  check = () => {},
  onlyInstance?: string
): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  let visited = 0
  let entries:
    | AsyncIterable<[string, FileSystemHandle]>
    | Array<[string, FileSystemHandle]>
  try {
    entries = onlyInstance
      ? [[onlyInstance, await root.getDirectoryHandle(onlyInstance)]]
      : root.entries()
  } catch (error) {
    if ((error as Error).name === 'NotFoundError') return []
    throw error
  }
  check()
  for await (const [instanceId, handle] of entries) {
    check()
    if (++visited > MAX_SCAN) throw new Error('DiagnosticScanLimit')
    if (handle.kind !== 'directory' || !safeName.test(instanceId)) continue
    const dir = handle as Directory
    for await (const [name, entry] of dir.entries()) {
      check()
      if (++visited > MAX_SCAN) throw new Error('DiagnosticScanLimit')
      const match = chunkName.exec(name)
      if (entry.kind !== 'file' || !match) continue
      const first = Number(match[1]),
        last = Number(match[2])
      // A damaged filename must never produce an unsafe/Infinity cursor.
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        first < 1 ||
        last < first
      )
        continue
      const file = entry as FileSystemFileHandle
      let metadata: File
      try {
        metadata = await file.getFile()
      } catch (error) {
        if ((error as Error).name === 'NotFoundError') continue
        throw error
      }
      check()
      chunks.push({
        instanceId,
        name,
        first,
        last,
        size: metadata.size,
        modified: metadata.lastModified,
        directory: dir,
        file,
      })
    }
  }
  return chunks
}

/** Reject corrupt/oversized records before they reach rendering or automation. */
function validEvent(
  event: unknown,
  instanceId: string
): event is WorkerLogEvent {
  if (!event || typeof event !== 'object') return false
  const e = event as WorkerLogEvent
  return (
    e.schemaVersion === 1 &&
    e.instanceId === instanceId &&
    Number.isSafeInteger(e.sequence) &&
    e.sequence > 0 &&
    typeof e.id === 'string' &&
    typeof e.ts === 'string' &&
    typeof e.message === 'string' &&
    e.message.length <= 1024 &&
    ['debug', 'info', 'warn', 'error'].includes(e.level) &&
    workerLogBytes(e) <= 16384
  )
}

/** Optional disk archive. Writers coordinate only diagnostics retention, using a
 * separate non-waiting Web Lock. Notebook ownership and readers never use it.
 */
export class WorkerLogArchive {
  constructor(
    private readonly root: RootProvider = () => navigator.storage.getDirectory()
  ) {}

  /** Called while holding ARCHIVE_LOCK; only recognized diagnostic chunks rotate. */
  async write(events: WorkerLogEvent[]): Promise<void> {
    if (!events.length) return
    const instanceId = events[0].instanceId
    if (!safeName.test(instanceId)) throw new Error('InvalidDiagnosticInstance')
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const bytes = new TextEncoder().encode(body).length
    if (bytes > CHUNK_BYTES || events.some((e) => e.instanceId !== instanceId))
      throw new Error('DiagnosticChunkLimit')
    const root = await directory(this.root, true)
    const chunks = (await scan(root)).sort(
      (a, b) => a.modified - b.modified || a.first - b.first
    )
    let total = chunks.reduce((n, c) => n + c.size, 0)
    let own = chunks
      .filter((c) => c.instanceId === instanceId)
      .reduce((n, c) => n + c.size, 0)
    let count = chunks.length
    let ownCount = chunks.filter((c) => c.instanceId === instanceId).length
    for (const c of chunks) {
      if (
        Date.now() - c.modified > MAX_AGE ||
        total + bytes > ORIGIN_BYTES ||
        count >= MAX_CHUNKS ||
        (c.instanceId === instanceId &&
          (own + bytes > INSTANCE_BYTES || ownCount >= MAX_INSTANCE_CHUNKS))
      ) {
        await c.directory.removeEntry(c.name)
        total -= c.size
        count--
        if (c.instanceId === instanceId) {
          own -= c.size
          ownCount--
        }
        // Nonrecursive deletion cannot remove unexpected files or notebook data.
        try {
          await root.removeEntry(c.instanceId)
        } catch {
          /* Still nonempty. */
        }
      }
    }
    const dir = await root.getDirectoryHandle(instanceId, { create: true })
    const file = await dir.getFileHandle(
      `${events[0].sequence}-${events[events.length - 1].sequence}.jsonl`,
      { create: true }
    )
    const writable = await file.createWritable()
    try {
      await writable.write(body)
      await writable.close()
    } catch (error) {
      try {
        await writable.abort()
      } catch {
        /* Preserve original failure. */
      }
      throw error
    }
  }

  /** Native OPFS reads bypass the worker, its locks and every IndexedDB database. */
  async list(check = () => {}) {
    let root: Directory
    try {
      root = await directory(this.root, false, check)
    } catch (error) {
      if ((error as Error).name === 'NotFoundError') return []
      throw error
    }
    check()
    const sessions = new Map<
      string,
      {
        instanceId: string
        bytes: number
        lastModified: number
        latestSequence: number
      }
    >()
    for (const c of await scan(root, check)) {
      const session = sessions.get(c.instanceId) ?? {
        instanceId: c.instanceId,
        bytes: 0,
        lastModified: 0,
        latestSequence: 0,
      }
      session.bytes += c.size
      session.lastModified = Math.max(session.lastModified, c.modified)
      session.latestSequence = Math.max(session.latestSequence, c.last)
      sessions.set(c.instanceId, session)
    }
    return [...sessions.values()].sort(
      (a, b) => b.lastModified - a.lastModified
    )
  }

  /** Read one bounded page. Corrupt chunks are isolated and explicitly counted. */
  async read(instanceId: string, query: WorkerLogQuery = {}, check = () => {}) {
    if (!safeName.test(instanceId)) throw new Error('InvalidDiagnosticInstance')
    let root: Directory
    try {
      root = await directory(this.root, false, check)
    } catch (error) {
      if ((error as Error).name === 'NotFoundError')
        return { ...pageWorkerLogs([], query), corruptChunks: 0 }
      throw error
    }
    check()
    const chunks = (await scan(root, check, instanceId))
      .filter(
        (c) =>
          c.instanceId === instanceId && c.last > (query.afterSequence ?? 0)
      )
      .sort((a, b) => a.first - b.first)
    const events: WorkerLogEvent[] = []
    let corruptChunks = 0
    let loadedBytes = 0
    let remaining = false
    let skippedThrough = query.afterSequence ?? 0
    for (const c of chunks) {
      check()
      // Bound work even if the directory was produced by another app version.
      if (c.size > CHUNK_BYTES || !c.size) {
        corruptChunks++
        skippedThrough = c.last
        continue
      }
      if (loadedBytes + c.size > 1048576) {
        remaining = true
        break
      }
      let file: File
      try {
        file = await c.file.getFile()
      } catch (error) {
        if ((error as Error).name === 'NotFoundError') {
          corruptChunks++
          skippedThrough = c.last
          continue
        }
        throw error
      }
      check()
      if (file.size > CHUNK_BYTES) {
        corruptChunks++
        skippedThrough = c.last
        continue
      }
      let text: string
      loadedBytes += file.size
      try {
        text = await file.text()
      } catch {
        check()
        corruptChunks++
        skippedThrough = c.last
        continue
      }
      check()
      try {
        if (!text.endsWith('\n')) throw new Error('IncompleteChunk')
        const parsed: unknown[] = text
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line))
        if (!parsed.length || parsed.some((e) => !validEvent(e, instanceId)))
          throw new Error('InvalidChunk')
        const batch = parsed as WorkerLogEvent[]
        if (
          batch[0].sequence !== c.first ||
          batch[batch.length - 1].sequence !== c.last ||
          batch.some((e, i) => i > 0 && e.sequence <= batch[i - 1].sequence)
        )
          throw new Error('InvalidSequence')
        events.push(...batch)
      } catch {
        corruptChunks++
        skippedThrough = c.last
      }
      const page = pageWorkerLogs(events, query)
      if (page.hasMore) {
        remaining = true
        break
      }
    }
    const page = pageWorkerLogs(
      events,
      query,
      chunks[chunks.length - 1]?.last ?? 0
    )
    // Do not skip valid events that did not fit the response budget.
    if (!page.hasMore)
      page.nextSequence = Math.max(page.nextSequence, skippedThrough)
    return { ...page, hasMore: page.hasMore || remaining, corruptChunks }
  }
}

export type WorkerLogPersistence = {
  state: 'idle' | 'writing' | 'degraded'
  pendingBytes: number
  dropped: number
  lastCommittedSequence: number
  errorName?: string
}

/** One physical write at a time, including after a timeout. Late completion is
 * allowed; bounded pending memory and drop counters prevent retry amplification.
 */
export class WorkerLogWriter {
  private queue: WorkerLogEvent[] = []
  private bytes = 0
  private running: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private health: WorkerLogPersistence = {
    state: 'idle',
    pendingBytes: 0,
    dropped: 0,
    lastCommittedSequence: 0,
  }
  private closed = false
  private nextAttemptAt = 0
  constructor(
    private readonly write: (
      events: WorkerLogEvent[]
    ) => Promise<void> = async (events) => {
      // ifAvailable avoids accumulating lock requests when another writer stalls.
      await navigator.locks.request(
        ARCHIVE_LOCK,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error('DiagnosticWriterBusy')
          await new WorkerLogArchive().write(events)
        }
      )
    }
  ) {}

  append(event: WorkerLogEvent): void {
    const size = workerLogBytes(event)
    if (
      this.closed ||
      this.bytes + size > CHUNK_BYTES ||
      this.queue.length >= 500
    ) {
      this.health.dropped++
      return
    }
    this.queue.push(event)
    this.bytes += size
    if (!this.running && !this.timer)
      this.timer = setTimeout(
        () => {
          this.timer = undefined
          void this.flush()
        },
        Math.max(1000, this.nextAttemptAt - Date.now())
      )
  }

  status(): WorkerLogPersistence {
    return { ...this.health, pendingBytes: this.bytes }
  }

  /** Explicit flush is usable by graceful shutdown but callers must bound waits. */
  flush(): Promise<void> {
    if (this.running) return this.running
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.queue.length) return Promise.resolve()
    const batch = this.queue
    this.queue = []
    this.bytes = 0
    this.health.state = 'writing'
    this.health.errorName = undefined
    const slow = setTimeout(() => {
      this.health.state = 'degraded'
      this.nextAttemptAt = Date.now() + 30000
      this.health.errorName = 'DiagnosticWriteTimeout'
    }, 5000)
    this.running = Promise.resolve()
      .then(() => this.write(batch))
      .then(
        () => {
          this.health.state = 'idle'
          this.nextAttemptAt = 0
          this.health.errorName = undefined
          this.health.lastCommittedSequence = batch[batch.length - 1].sequence
        },
        (error) => {
          this.health.state = 'degraded'
          this.nextAttemptAt = Date.now() + 30000
          this.health.dropped += batch.length
          this.health.errorName =
            error instanceof DOMException ? error.name : 'DiagnosticWriteFailed'
        }
      )
      .finally(() => {
        clearTimeout(slow)
        this.running = undefined
        if (!this.closed && this.queue.length)
          this.timer = setTimeout(
            () => {
              this.timer = undefined
              void this.flush()
            },
            this.health.state === 'degraded' ? 30000 : 1000
          )
      })
    return this.running
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
  }
}

// Timed-out native reads may still exist. Retain their slots until they settle,
// and check deadlines between awaits so late results cannot restart a scan.
let pendingReads = 0
export async function readWorkerArchive<T>(
  run: (archive: WorkerLogArchive, check: () => void) => Promise<T>,
  timeoutMs = 5000
): Promise<T> {
  if (pendingReads >= 2)
    throw new Error('Diagnostic reads are still pending in browser storage')
  const duration = Number.isFinite(timeoutMs)
    ? Math.max(100, Math.min(5000, timeoutMs))
    : 5000
  const deadline = Date.now() + duration
  const check = () => {
    if (Date.now() >= deadline)
      throw new Error('Diagnostic archive read timed out')
  }
  pendingReads++
  const operation = Promise.resolve()
    .then(() => run(new WorkerLogArchive(), check))
    .finally(() => {
      pendingReads--
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Diagnostic archive read timed out')),
          duration
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
