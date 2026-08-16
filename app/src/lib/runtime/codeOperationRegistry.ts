import { appLogger } from '../logging/runtime'
import { getClaimedSessionId } from '../tabIdentity'
import type {
  CodeModeExecutionHooks,
  CodeModeExecutor,
} from './codeModeExecutor'
import {
  type CodeOperationStorageLike,
  codeOperationStorage,
} from './codeOperationStorage'
import {
  type CancelExecuteCodeOperationInput,
  DEFAULT_EXECUTE_CODE_MAX_RUNTIME_MS,
  DEFAULT_EXECUTE_CODE_OUTPUT_BYTES,
  DEFAULT_EXECUTE_CODE_POLL_BYTES,
  DEFAULT_EXECUTE_CODE_RESULT_TTL_MS,
  DEFAULT_EXECUTE_CODE_WAIT_TIMEOUT_MS,
  type ExecuteCodeOperation,
  type ExecuteCodeOperationRecord,
  type ExecuteCodeOutputEvent,
  type ExecuteCodeOutputPage,
  type GetExecuteCodeOperationInput,
  MAX_EXECUTE_CODE_MAX_RUNTIME_MS,
  MAX_EXECUTE_CODE_POLL_WAIT_MS,
  MAX_EXECUTE_CODE_WAIT_TIMEOUT_MS,
  type StartExecuteCodeOperationInput,
  isExecuteCodeOperationTerminal,
} from './codeOperationTypes'

const OUTPUT_EVENT_CHUNK_BYTES = 16 * 1024
const DEFAULT_POLL_AFTER_MS = 1_000
const CANCEL_GRACE_MS = 1_000

type SettledCallback = (operation: ExecuteCodeOperation) => void

type StartOptions = StartExecuteCodeOperationInput & {
  hooks?: CodeModeExecutionHooks
  onSettled?: SettledCallback
  onAccepted?: (operationId: string) => void
}

type LiveOperation = {
  abortController: AbortController
  completion: Promise<void>
  resolveCompletion: () => void
  version: number
  waiters: Set<() => void>
  persistChain: Promise<void>
  hooks?: CodeModeExecutionHooks
  onSettled?: SettledCallback
  cancelRequested: boolean
}

type RegistryOptions = {
  executor: CodeModeExecutor
  storage?: CodeOperationStorageLike
  getSessionId?: () => Promise<string>
  now?: () => Date
  createId?: () => string
  maxOutputBytes?: number
  resultTtlMs?: number
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

function normalizeIdempotencyKey(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 128) : undefined
}

async function hashString(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
  }
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function createOperationId(): string {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `exec_${id}`
}

async function completesWithin(
  completion: Promise<void>,
  delayMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), delayMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    String(error).toLowerCase().includes('cancel')
  )
}

function isRuntimeTimeout(error: unknown): boolean {
  return String(error).includes('timed out after')
}

function retainUtf8Output(
  value: string,
  maxBytes: number
): {
  chunks: Array<{ text: string; bytes: number }>
  totalBytes: number
  retainedBytes: number
} {
  const encoder = new TextEncoder()
  const totalBytes = encoder.encode(value).length
  if (maxBytes <= 0 || totalBytes === 0) {
    return { chunks: [], totalBytes, retainedBytes: 0 }
  }

  const chunks: Array<{ text: string; bytes: number }> = []
  let current = ''
  let currentBytes = 0
  let retainedBytes = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).length
    if (retainedBytes + characterBytes > maxBytes) {
      break
    }
    if (
      currentBytes > 0 &&
      currentBytes + characterBytes > OUTPUT_EVENT_CHUNK_BYTES
    ) {
      chunks.push({ text: current, bytes: currentBytes })
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += characterBytes
    retainedBytes += characterBytes
  }
  if (current) {
    chunks.push({ text: current, bytes: currentBytes })
  }
  return { chunks, totalBytes, retainedBytes }
}

export class CodeOperationRegistry {
  private readonly executor: CodeModeExecutor
  private readonly storage: CodeOperationStorageLike
  private readonly getSessionId: () => Promise<string>
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly maxOutputBytes: number
  private readonly resultTtlMs: number
  private readonly records = new Map<string, ExecuteCodeOperationRecord>()
  private readonly outputEvents = new Map<string, ExecuteCodeOutputEvent[]>()
  private readonly live = new Map<string, LiveOperation>()
  private readonly idempotencyReservations = new Map<string, Promise<void>>()
  private initialization: Promise<string> | null = null
  private persistenceEnabled = true

  constructor(options: RegistryOptions) {
    this.executor = options.executor
    this.storage = options.storage ?? codeOperationStorage
    this.getSessionId = options.getSessionId ?? getClaimedSessionId
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? createOperationId
    this.maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_EXECUTE_CODE_OUTPUT_BYTES
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_EXECUTE_CODE_RESULT_TTL_MS
  }

  async start(input: StartOptions): Promise<ExecuteCodeOperation> {
    const sessionId = await this.ensureInitialized()
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
    if (idempotencyKey) {
      const reservationKey = `${sessionId}\u0000${idempotencyKey}`
      const pendingReservation =
        this.idempotencyReservations.get(reservationKey)
      if (pendingReservation) {
        await pendingReservation
      }
      let release = () => {}
      const reservation = new Promise<void>((resolve) => {
        release = resolve
      })
      this.idempotencyReservations.set(reservationKey, reservation)
      try {
        return await this.startOperation(
          input,
          sessionId,
          idempotencyKey,
          release
        )
      } finally {
        release()
        if (this.idempotencyReservations.get(reservationKey) === reservation) {
          this.idempotencyReservations.delete(reservationKey)
        }
      }
    }
    return this.startOperation(input, sessionId)
  }

  private async startOperation(
    input: StartOptions,
    sessionId: string,
    idempotencyKey?: string,
    onPrepared?: () => void
  ): Promise<ExecuteCodeOperation> {
    const code =
      typeof input.code === 'string' ? input.code : String(input.code)
    const waitTimeoutMs = clampInteger(
      input.timeoutMs,
      DEFAULT_EXECUTE_CODE_WAIT_TIMEOUT_MS,
      1_000,
      MAX_EXECUTE_CODE_WAIT_TIMEOUT_MS
    )
    const maxRuntimeMs = clampInteger(
      input.maxRuntimeMs,
      DEFAULT_EXECUTE_CODE_MAX_RUNTIME_MS,
      1_000,
      MAX_EXECUTE_CODE_MAX_RUNTIME_MS
    )
    const timeoutBehavior =
      input.timeoutBehavior === 'cancel' ? 'cancel' : 'continue'
    const codeHash = await hashString(JSON.stringify({ code, maxRuntimeMs }))

    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        sessionId,
        idempotencyKey
      )
      if (existing) {
        if (existing.codeHash !== codeHash) {
          throw new Error(
            `IDEMPOTENCY_CONFLICT: ${idempotencyKey} was already used for different ExecuteCode input.`
          )
        }
        onPrepared?.()
        return this.snapshot(existing, { waitExpired: false })
      }
    }

    const createdAt = this.now().toISOString()
    const operationId = this.createId()
    const record: ExecuteCodeOperationRecord = {
      id: operationId,
      sessionId,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(
        this.now().getTime() + this.resultTtlMs
      ).toISOString(),
      codeHash,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      timeoutBehavior,
      waitTimeoutMs,
      maxRuntimeMs,
      outputSequence: 0,
      retainedOutputBytes: 0,
      droppedOutputBytes: 0,
      outputTruncated: false,
    }
    this.records.set(operationId, record)
    this.outputEvents.set(operationId, [])
    await this.persistRecord(record)
    try {
      input.onAccepted?.(operationId)
    } catch (error) {
      appLogger.error('ExecuteCode acceptance callback failed', {
        attrs: {
          scope: 'webmcp.execute_code.operation',
          operationId,
          error: String(error),
        },
      })
    }

    let resolveCompletion = () => {}
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    const live: LiveOperation = {
      abortController: new AbortController(),
      completion,
      resolveCompletion,
      version: 0,
      waiters: new Set(),
      persistChain: Promise.resolve(),
      hooks: input.hooks,
      onSettled: input.onSettled,
      cancelRequested: false,
    }
    this.live.set(operationId, live)
    void this.run(record, code, live)
    onPrepared?.()

    const completed = await completesWithin(completion, waitTimeoutMs)
    const latest = await this.requireOperation(operationId, sessionId)
    if (completed || isExecuteCodeOperationTerminal(latest.status)) {
      return this.snapshot(latest, { waitExpired: false })
    }

    if (timeoutBehavior === 'cancel') {
      return this.cancel({ operationId })
    }

    return this.snapshot(latest, { waitExpired: true })
  }

  async get(
    input: GetExecuteCodeOperationInput
  ): Promise<ExecuteCodeOperation> {
    const sessionId = await this.ensureInitialized()
    const operationId = String(input.operationId ?? '').trim()
    const afterSequence = clampInteger(
      input.afterSequence,
      0,
      0,
      Number.MAX_SAFE_INTEGER
    )
    const waitMs = clampInteger(
      input.waitMs,
      0,
      0,
      MAX_EXECUTE_CODE_POLL_WAIT_MS
    )
    let record = await this.requireOperation(operationId, sessionId)

    if (
      waitMs > 0 &&
      !isExecuteCodeOperationTerminal(record.status) &&
      record.outputSequence <= afterSequence
    ) {
      await this.waitForChange(operationId, waitMs)
      record = await this.requireOperation(operationId, sessionId)
    }

    return this.snapshot(record, {
      waitExpired: false,
      afterSequence,
      maxBytes: input.maxBytes,
    })
  }

  async cancel(
    input: CancelExecuteCodeOperationInput
  ): Promise<ExecuteCodeOperation> {
    const sessionId = await this.ensureInitialized()
    const operationId = String(input.operationId ?? '').trim()
    let record = await this.requireOperation(operationId, sessionId)
    if (isExecuteCodeOperationTerminal(record.status)) {
      return this.snapshot(record, {
        waitExpired: false,
        afterSequence: input.afterSequence,
        maxBytes: input.maxBytes,
      })
    }

    const live = this.live.get(operationId)
    if (!live) {
      record = await this.updateRecord(operationId, {
        status: 'interrupted',
        completedAt: this.now().toISOString(),
        error: {
          code: 'CONTROL_HANDLE_LOST',
          message: 'The live ExecuteCode control handle is unavailable.',
          downstreamMayContinue: true,
        },
      })
      return this.snapshot(record, { waitExpired: false })
    }

    live.cancelRequested = true
    await this.updateRecord(operationId, { status: 'cancel_requested' })
    live.abortController.abort(new DOMException('Cancelled', 'AbortError'))
    await completesWithin(live.completion, CANCEL_GRACE_MS)
    record = await this.requireOperation(operationId, sessionId)
    return this.snapshot(record, {
      waitExpired: false,
      afterSequence: input.afterSequence,
      maxBytes: input.maxBytes,
    })
  }

  private async run(
    record: ExecuteCodeOperationRecord,
    code: string,
    live: LiveOperation
  ): Promise<void> {
    const operationId = record.id
    try {
      await this.updateRecord(operationId, {
        status: 'running',
        startedAt: this.now().toISOString(),
      })
      const result = await this.executor.execute({
        code,
        source: 'webmcp',
        timeoutMs: record.maxRuntimeMs,
        signal: live.abortController.signal,
        hooks: {
          onStdout: (chunk) => {
            this.appendOutput(operationId, 'stdout', chunk)
            live.hooks?.onStdout?.(chunk)
          },
          onStderr: (chunk) => {
            this.appendOutput(operationId, 'stderr', chunk)
            live.hooks?.onStderr?.(chunk)
          },
        },
      })
      const completedAt = this.now().toISOString()
      if (live.cancelRequested || live.abortController.signal.aborted) {
        await this.updateRecord(operationId, {
          status: 'cancelled',
          exitCode: 1,
          completedAt,
          error: {
            code: 'EXECUTION_CANCELLED',
            message: 'ExecuteCode was cancelled.',
            downstreamMayContinue: true,
          },
        })
        return
      }
      await this.updateRecord(operationId, {
        status: result.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: result.exitCode,
        completedAt,
        ...(result.exitCode === 0
          ? { error: undefined }
          : {
              error: {
                code: 'EXECUTION_FAILED',
                message: `ExecuteCode exited with code ${result.exitCode}.`,
              },
            }),
      })
    } catch (error) {
      const completedAt = this.now().toISOString()
      const cancelled = live.cancelRequested || isAbortError(error)
      await this.updateRecord(operationId, {
        status: cancelled ? 'cancelled' : 'failed',
        exitCode: 1,
        completedAt,
        error: cancelled
          ? {
              code: 'EXECUTION_CANCELLED',
              message: 'ExecuteCode was cancelled.',
              downstreamMayContinue: true,
            }
          : {
              code: isRuntimeTimeout(error)
                ? 'MAX_RUNTIME_EXCEEDED'
                : 'EXECUTION_FAILED',
              message: error instanceof Error ? error.message : String(error),
              ...(isRuntimeTimeout(error)
                ? { downstreamMayContinue: true }
                : {}),
            },
      })
    } finally {
      await live.persistChain
      const finalRecord = this.records.get(operationId)
      if (finalRecord) {
        try {
          live.onSettled?.(
            await this.snapshot(finalRecord, { waitExpired: false })
          )
        } catch (error) {
          appLogger.error('ExecuteCode settlement callback failed', {
            attrs: {
              scope: 'webmcp.execute_code.operation',
              operationId,
              error: String(error),
            },
          })
        }
      }
      live.resolveCompletion()
      this.notify(operationId)
      this.live.delete(operationId)
    }
  }

  private appendOutput(
    operationId: string,
    stream: ExecuteCodeOutputEvent['stream'],
    chunk: string
  ): void {
    if (!chunk) {
      return
    }
    const record = this.records.get(operationId)
    const live = this.live.get(operationId)
    if (!record || !live) {
      return
    }

    const remaining = Math.max(
      0,
      this.maxOutputBytes - record.retainedOutputBytes
    )
    const retained = retainUtf8Output(chunk, remaining)
    for (const part of retained.chunks) {
      const sequence = record.outputSequence + 1
      record.outputSequence = sequence
      const event: ExecuteCodeOutputEvent = {
        operationId,
        sequence,
        stream,
        text: part.text,
        createdAt: this.now().toISOString(),
      }
      record.retainedOutputBytes += part.bytes
      const events = this.outputEvents.get(operationId) ?? []
      events.push(event)
      this.outputEvents.set(operationId, events)
      this.queuePersistence(operationId, () =>
        this.storage.appendOutputEvent(event)
      )
    }
    const dropped = retained.totalBytes - retained.retainedBytes
    if (dropped > 0) {
      record.droppedOutputBytes += dropped
      record.outputTruncated = true
      if (retained.chunks.length === 0) {
        record.outputSequence += 1
      }
    }
    record.updatedAt = this.now().toISOString()
    this.records.set(operationId, { ...record })
    this.queuePersistence(operationId, () =>
      this.storage.putOperation({ ...record })
    )
    this.notify(operationId)
  }

  private async snapshot(
    record: ExecuteCodeOperationRecord,
    options: {
      waitExpired: boolean
      afterSequence?: number
      maxBytes?: number
    }
  ): Promise<ExecuteCodeOperation> {
    const output = await this.outputPage(
      record,
      clampInteger(options.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER),
      clampInteger(
        options.maxBytes,
        DEFAULT_EXECUTE_CODE_POLL_BYTES,
        1_024,
        this.maxOutputBytes
      )
    )
    return {
      operationId: record.id,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      expiresAt: record.expiresAt,
      waitExpired: options.waitExpired,
      ...(typeof record.exitCode === 'number'
        ? { exitCode: record.exitCode }
        : {}),
      ...(record.error ? { error: record.error } : {}),
      output,
      ...(!isExecuteCodeOperationTerminal(record.status)
        ? { pollAfterMs: DEFAULT_POLL_AFTER_MS }
        : {}),
    }
  }

  private async outputPage(
    record: ExecuteCodeOperationRecord,
    afterSequence: number,
    maxBytes: number
  ): Promise<ExecuteCodeOutputPage> {
    let events = this.outputEvents.get(record.id)
    if (!events) {
      events = this.persistenceEnabled
        ? await this.storage.getOutputEvents(record.id)
        : []
      this.outputEvents.set(record.id, events)
    }
    const available = events.filter((event) => event.sequence > afterSequence)
    const selected: ExecuteCodeOutputEvent[] = []
    let selectedBytes = 0
    for (const event of available) {
      const eventBytes = new TextEncoder().encode(event.text).length
      if (selected.length > 0 && selectedBytes + eventBytes > maxBytes) {
        break
      }
      selected.push(event)
      selectedBytes += eventBytes
    }
    const nextSequence =
      selected.at(-1)?.sequence ??
      (available.length === 0 ? record.outputSequence : afterSequence)
    return {
      events: selected,
      nextSequence,
      latestSequence: record.outputSequence,
      hasMore: selected.length < available.length,
      truncated: record.outputTruncated,
      droppedBytes: record.droppedOutputBytes,
    }
  }

  private async ensureInitialized(): Promise<string> {
    if (!this.initialization) {
      this.initialization = this.getSessionId().then(async (sessionId) => {
        try {
          await this.storage.initialize(sessionId)
        } catch (error) {
          this.persistenceEnabled = false
          appLogger.error('ExecuteCode operation persistence unavailable', {
            attrs: {
              scope: 'webmcp.execute_code.operation',
              sessionId,
              error: String(error),
            },
          })
        }
        return sessionId
      })
    }
    return this.initialization
  }

  private async findByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string
  ): Promise<ExecuteCodeOperationRecord | null> {
    const inMemory = Array.from(this.records.values()).find(
      (record) =>
        record.sessionId === sessionId &&
        record.idempotencyKey === idempotencyKey
    )
    if (inMemory) {
      return inMemory
    }
    if (!this.persistenceEnabled) {
      return null
    }
    const stored = await this.storage.findByIdempotencyKey(
      sessionId,
      idempotencyKey
    )
    if (stored) {
      this.records.set(stored.id, stored)
    }
    return stored
  }

  private async requireOperation(
    operationId: string,
    sessionId: string
  ): Promise<ExecuteCodeOperationRecord> {
    if (!operationId) {
      throw new Error('operationId is required.')
    }
    let record = this.records.get(operationId) ?? null
    if (!record && this.persistenceEnabled) {
      record = await this.storage.getOperation(operationId)
      if (record) {
        this.records.set(operationId, record)
      }
    }
    if (!record || record.sessionId !== sessionId) {
      throw new Error(`ExecuteCode operation not found: ${operationId}`)
    }
    if (
      record.status !== 'expired' &&
      record.expiresAt <= this.now().toISOString()
    ) {
      record = await this.updateRecord(operationId, { status: 'expired' })
    }
    return record
  }

  private async updateRecord(
    operationId: string,
    patch: Partial<ExecuteCodeOperationRecord>
  ): Promise<ExecuteCodeOperationRecord> {
    const existing = this.records.get(operationId)
    if (!existing) {
      throw new Error(`ExecuteCode operation not found: ${operationId}`)
    }
    const next: ExecuteCodeOperationRecord = {
      ...existing,
      ...patch,
      updatedAt: this.now().toISOString(),
    }
    this.records.set(operationId, next)
    await this.persistRecord(next)
    this.notify(operationId)
    return next
  }

  private async persistRecord(
    record: ExecuteCodeOperationRecord
  ): Promise<void> {
    if (!this.persistenceEnabled) {
      return
    }
    const live = this.live.get(record.id)
    if (live) {
      this.queuePersistence(record.id, () => this.storage.putOperation(record))
      await live.persistChain
      return
    }
    try {
      await this.storage.putOperation(record)
    } catch (error) {
      this.persistenceEnabled = false
      appLogger.error('Failed to persist ExecuteCode operation', {
        attrs: {
          scope: 'webmcp.execute_code.operation',
          operationId: record.id,
          error: String(error),
        },
      })
    }
  }

  private queuePersistence(
    operationId: string,
    task: () => Promise<void>
  ): void {
    const live = this.live.get(operationId)
    if (!live || !this.persistenceEnabled) {
      return
    }
    live.persistChain = live.persistChain.then(task).catch((error) => {
      this.persistenceEnabled = false
      appLogger.error('Failed to persist ExecuteCode output', {
        attrs: {
          scope: 'webmcp.execute_code.operation',
          operationId,
          error: String(error),
        },
      })
    })
  }

  private notify(operationId: string): void {
    const live = this.live.get(operationId)
    if (!live) {
      return
    }
    live.version += 1
    for (const waiter of live.waiters) {
      waiter()
    }
    live.waiters.clear()
  }

  private async waitForChange(
    operationId: string,
    waitMs: number
  ): Promise<void> {
    const live = this.live.get(operationId)
    if (!live) {
      return
    }
    const version = live.version
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        live.waiters.delete(finish)
        resolve()
      }
      const timer = setTimeout(finish, waitMs)
      live.waiters.add(finish)
      if (live.version !== version) {
        finish()
      }
    })
  }
}

export function createCodeOperationRegistry(
  options: RegistryOptions
): CodeOperationRegistry {
  return new CodeOperationRegistry(options)
}
