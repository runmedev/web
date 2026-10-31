// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CodeModeExecutor } from './codeModeExecutor'
import {
  type CodeOperationRegistry,
  createCodeOperationRegistry,
} from './codeOperationRegistry'
import type { CodeOperationStorageLike } from './codeOperationStorage'
import type {
  ExecuteCodeOperationRecord,
  ExecuteCodeOutputEvent,
} from './codeOperationTypes'

class MemoryCodeOperationStorage implements CodeOperationStorageLike {
  readonly operations = new Map<string, ExecuteCodeOperationRecord>()
  readonly outputEvents = new Map<string, ExecuteCodeOutputEvent[]>()

  async initialize(): Promise<void> {}

  async getOperation(
    operationId: string
  ): Promise<ExecuteCodeOperationRecord | null> {
    return this.operations.get(operationId) ?? null
  }

  async findByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string
  ): Promise<ExecuteCodeOperationRecord | null> {
    return (
      Array.from(this.operations.values()).find(
        (operation) =>
          operation.sessionId === sessionId &&
          operation.idempotencyKey === idempotencyKey
      ) ?? null
    )
  }

  async putOperation(record: ExecuteCodeOperationRecord): Promise<void> {
    this.operations.set(record.id, structuredClone(record))
  }

  async appendOutputEvent(event: ExecuteCodeOutputEvent): Promise<void> {
    const events = this.outputEvents.get(event.operationId) ?? []
    events.push(structuredClone(event))
    this.outputEvents.set(event.operationId, events)
  }

  async getOutputEvents(
    operationId: string
  ): Promise<ExecuteCodeOutputEvent[]> {
    return structuredClone(this.outputEvents.get(operationId) ?? [])
  }
}

function createRegistry(
  executor: CodeModeExecutor,
  options: {
    storage?: MemoryCodeOperationStorage
    maxOutputBytes?: number
  } = {}
): {
  registry: CodeOperationRegistry
  storage: MemoryCodeOperationStorage
} {
  const storage = options.storage ?? new MemoryCodeOperationStorage()
  return {
    registry: createCodeOperationRegistry({
      executor,
      storage,
      getSessionId: async () => 'test-session',
      createId: () => 'exec-test',
      maxOutputBytes: options.maxOutputBytes,
    }),
    storage,
  }
}

describe('CodeOperationRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a Runme-assigned operation id for fast successful work', async () => {
    const executor: CodeModeExecutor = {
      execute: vi.fn(async ({ hooks }) => {
        hooks?.onStdout?.('done\n')
        return { output: 'done\n', exitCode: 0 }
      }),
    }
    const { registry, storage } = createRegistry(executor)

    const result = await registry.start({ code: "console.log('done')" })

    expect(result).toMatchObject({
      operationId: 'exec-test',
      status: 'succeeded',
      waitExpired: false,
      exitCode: 0,
    })
    expect(result.output.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        stream: 'stdout',
        text: 'done\n',
      }),
    ])
    expect(storage.operations.get('exec-test')?.status).toBe('succeeded')

    const { registry: reloadedRegistry } = createRegistry(executor, { storage })
    const reloaded = await reloadedRegistry.get({
      operationId: 'exec-test',
    })
    expect(reloaded.status).toBe('succeeded')
    expect(reloaded.output.events[0]?.text).toBe('done\n')
  })

  it('returns running after the wait budget and lets callers poll to completion', async () => {
    vi.useFakeTimers()
    let finish!: (value: { output: string; exitCode: number }) => void
    const executor: CodeModeExecutor = {
      execute: vi.fn(
        ({ hooks }) =>
          new Promise<{ output: string; exitCode: number }>((resolve) => {
            finish = resolve
            hooks?.onStdout?.('started\n')
          })
      ),
    }
    const { registry } = createRegistry(executor)

    const startPromise = registry.start({
      code: 'await slowWork()',
      timeoutMs: 1_000,
    })
    await vi.waitFor(() => {
      expect(executor.execute).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1_000)
    const started = await startPromise

    expect(started).toMatchObject({
      operationId: 'exec-test',
      status: 'running',
      waitExpired: true,
      pollAfterMs: 1_000,
    })
    expect(started.output.events[0]?.text).toBe('started\n')

    const drained = vi.fn()
    const shutdown = registry.waitForIdle().then(drained)
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).not.toHaveBeenCalled()
    finish({ output: 'started\n', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await shutdown
    expect(drained).toHaveBeenCalledTimes(1)
    const completed = await registry.get({
      operationId: 'exec-test',
      afterSequence: started.output.nextSequence,
    })
    expect(completed.status).toBe('succeeded')
    expect(completed.output.events).toEqual([])
  })

  it('cancels on wait expiry when timeoutBehavior is cancel', async () => {
    vi.useFakeTimers()
    const executor: CodeModeExecutor = {
      execute: vi.fn(
        ({ signal }) =>
          new Promise<{ output: string; exitCode: number }>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => resolve({ output: '', exitCode: 1 }),
              { once: true }
            )
          })
      ),
    }
    const { registry } = createRegistry(executor)

    const startPromise = registry.start({
      code: 'await slowWork()',
      timeoutMs: 1_000,
      timeoutBehavior: 'cancel',
    })
    await vi.waitFor(() => {
      expect(executor.execute).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await startPromise

    expect(result).toMatchObject({
      operationId: 'exec-test',
      status: 'cancelled',
      error: {
        code: 'EXECUTION_CANCELLED',
        downstreamMayContinue: true,
      },
    })
  })

  it('deduplicates retries by idempotency key and rejects conflicting input', async () => {
    let finish!: (value: { output: string; exitCode: number }) => void
    const executor: CodeModeExecutor = {
      execute: vi.fn(
        () =>
          new Promise<{ output: string; exitCode: number }>((resolve) => {
            finish = resolve
          })
      ),
    }
    const { registry } = createRegistry(executor)
    const onAccepted = vi.fn()

    const firstPromise = registry.start({
      code: 'await deploy()',
      idempotencyKey: 'deploy-42',
      onAccepted,
    })
    await vi.waitFor(() => {
      expect(executor.execute).toHaveBeenCalledTimes(1)
    })
    const retry = await registry.start({
      code: 'await deploy()',
      idempotencyKey: 'deploy-42',
      onAccepted,
    })

    expect(retry).toMatchObject({
      operationId: 'exec-test',
      status: 'running',
    })
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(onAccepted).toHaveBeenCalledTimes(1)
    finish({ output: '', exitCode: 0 })
    const first = await firstPromise
    expect(first.operationId).toBe(retry.operationId)
    await expect(
      registry.start({
        code: 'await deployAgain()',
        idempotencyKey: 'deploy-42',
      })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  })

  it('bounds retained output and reports dropped bytes', async () => {
    const executor: CodeModeExecutor = {
      execute: vi.fn(async ({ hooks }) => {
        hooks?.onStdout?.('abcd🙂')
        return { output: 'abcd🙂', exitCode: 0 }
      }),
    }
    const { registry } = createRegistry(executor, { maxOutputBytes: 5 })

    const result = await registry.start({ code: "console.log('abcd🙂')" })

    expect(result.output.events.map((event) => event.text).join('')).toBe(
      'abcd'
    )
    expect(result.output).toMatchObject({
      truncated: true,
      droppedBytes: 4,
    })
  })

  it('paginates output within the advertised minimum page size', async () => {
    const executor: CodeModeExecutor = {
      execute: vi.fn(async ({ hooks }) => {
        hooks?.onStdout?.('x'.repeat(20 * 1024))
        return { output: '', exitCode: 0 }
      }),
    }
    const { registry } = createRegistry(executor, {
      maxOutputBytes: 64 * 1024,
    })

    const started = await registry.start({ code: "console.log('x')" })
    const firstPage = await registry.get({
      operationId: started.operationId,
      maxBytes: 16 * 1024,
    })

    expect(
      firstPage.output.events.reduce(
        (bytes, event) => bytes + new TextEncoder().encode(event.text).length,
        0
      )
    ).toBeLessThanOrEqual(16 * 1024)
    expect(firstPage.output.hasMore).toBe(true)
  })

  it('reports the hard runtime limit separately from the initial wait budget', async () => {
    const executor: CodeModeExecutor = {
      execute: vi.fn(async () => {
        throw new Error('ExecuteCode timed out after 1000ms')
      }),
    }
    const { registry } = createRegistry(executor)

    const result = await registry.start({
      code: 'await neverFinishes()',
      maxRuntimeMs: 1_000,
    })

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'MAX_RUNTIME_EXCEEDED',
        downstreamMayContinue: true,
      },
    })
  })
})

it.each(['initialize', 'putOperation', 'appendOutputEvent'] as const)(
  'returns output with an operation ID when %s stalls',
  async (method) => {
    vi.useFakeTimers()
    const storage = new MemoryCodeOperationStorage()
    vi.spyOn(storage, method).mockImplementation(() => new Promise(() => {}))
    const executor: CodeModeExecutor = {
      execute: vi.fn(async ({ hooks }) => {
        hooks?.onStdout?.('health-check\n')
        return { output: 'health-check\n', exitCode: 0 }
      }),
    }
    const { registry } = createRegistry(executor, { storage })
    try {
      const pending = registry.start({
        code: "console.log('health-check')",
        timeoutMs: 1000,
        maxRuntimeMs: 2000,
      })
      await vi.advanceTimersByTimeAsync(5000)
      const initial = await pending
      const result = await registry.get({ operationId: initial.operationId })
      expect(result.status).toBe('succeeded')
      expect(result.persistence).toBe('memory')
      expect(result.output.events[0]?.text).toBe('health-check\n')
      expect(executor.execute).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  }
)

it('does not execute a keyed request if saved deduplication records are unavailable', async () => {
  const storage = new MemoryCodeOperationStorage()
  vi.spyOn(storage, 'initialize').mockRejectedValue(new Error('unavailable'))
  const executor = { execute: vi.fn() }
  const { registry } = createRegistry(executor, { storage })
  await expect(
    registry.start({
      code: 'createSomething()',
      idempotencyKey: 'existing-key',
    })
  ).rejects.toThrow('IDEMPOTENCY_UNAVAILABLE')
  expect(executor.execute).not.toHaveBeenCalled()
})

it('does not execute a keyed request if its acceptance write fails', async () => {
  const storage = new MemoryCodeOperationStorage()
  vi.spyOn(storage, 'putOperation').mockRejectedValue(new Error('unavailable'))
  const executor = { execute: vi.fn() }
  const { registry } = createRegistry(executor, { storage })
  const result = await registry.start({
    code: 'createSomething()',
    idempotencyKey: 'new-key',
  })
  expect(result.status).toBe('failed')
  expect(result.error?.code).toBe('IDEMPOTENCY_UNAVAILABLE')
  expect(executor.execute).not.toHaveBeenCalled()
})

it('runs without durable storage when acquiring the session identity stalls', async () => {
  vi.useFakeTimers()
  const storage = new MemoryCodeOperationStorage()
  const initialize = vi.spyOn(storage, 'initialize')
  const executor = { execute: vi.fn(async () => ({ output: '', exitCode: 0 })) }
  const registry = createCodeOperationRegistry({
    executor,
    storage,
    getSessionId: () => new Promise(() => {}),
  })
  try {
    const pending = registry.start({ code: '1' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({
      status: 'succeeded',
      persistence: 'memory',
    })
    expect(initialize).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('does not execute after cancellation while saving the running state', async () => {
  vi.useFakeTimers()
  const storage = new MemoryCodeOperationStorage()
  const original = storage.putOperation.bind(storage)
  vi.spyOn(storage, 'putOperation').mockImplementation((record) =>
    record.status === 'running' ? new Promise(() => {}) : original(record)
  )
  const executor = { execute: vi.fn() }
  const { registry } = createRegistry(executor, { storage })
  try {
    const pending = registry.start({
      code: 'createSomething()',
      timeoutMs: 1000,
      timeoutBehavior: 'cancel',
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect((await pending).status).toBe('cancelled')
    expect(executor.execute).not.toHaveBeenCalled()
    await registry.waitForIdle()
  } finally {
    vi.useRealTimers()
  }
})
