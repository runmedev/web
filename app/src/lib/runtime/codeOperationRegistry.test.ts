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

    finish({ output: 'started\n', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(0)
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
