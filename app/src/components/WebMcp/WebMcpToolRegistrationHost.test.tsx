// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const {
  executeMock,
  startOperationMock,
  getOperationMock,
  cancelOperationMock,
  appConsoleDataMock,
  appLoggerMock,
} = vi.hoisted(() => ({
  executeMock: vi.fn(),
  startOperationMock: vi.fn(),
  getOperationMock: vi.fn(),
  cancelOperationMock: vi.fn(),
  appConsoleDataMock: {
    hydrate: vi.fn(),
    startExternalExecution: vi.fn(),
    appendStdout: vi.fn(),
    appendStderr: vi.fn(),
    completeExecution: vi.fn(),
    failExecution: vi.fn(),
  },
  appLoggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../lib/runtime/useCodeModeExecutor', () => ({
  useCodeModeExecutor: () => ({
    execute: executeMock,
  }),
}))

vi.mock('../../lib/runtime/useCodeOperationRegistry', () => ({
  useCodeOperationRegistry: () => ({
    start: startOperationMock,
    get: getOperationMock,
    cancel: cancelOperationMock,
  }),
}))

vi.mock('../../lib/appConsole/appConsoleController', () => ({
  getAppConsoleData: () => appConsoleDataMock,
}))

vi.mock('../../lib/logging/runtime', () => ({
  appLogger: appLoggerMock,
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({ getCurrentDoc: () => null }),
}))

vi.mock('../../contexts/NotebookContext', () => ({
  useNotebookContext: () => ({ getNotebookData: () => null }),
}))

import WebMcpToolRegistrationHost from './WebMcpToolRegistrationHost'

describe('WebMcpToolRegistrationHost', () => {
  beforeEach(() => {
    executeMock.mockReset()
    startOperationMock.mockReset()
    startOperationMock.mockImplementation(async (input) => {
      input.onAccepted?.('exec-1')
      input.hooks?.onStdout?.('stdout chunk')
      input.hooks?.onStderr?.('stderr chunk')
      const operation = {
        operationId: 'exec-1',
        status: 'succeeded',
        createdAt: '2026-08-16T00:00:00.000Z',
        completedAt: '2026-08-16T00:00:01.000Z',
        expiresAt: '2026-08-17T00:00:00.000Z',
        waitExpired: false,
        exitCode: 0,
        output: {
          events: [],
          nextSequence: 0,
          latestSequence: 0,
          hasMore: false,
          truncated: false,
          droppedBytes: 0,
        },
      }
      input.onSettled?.(operation)
      return operation
    })
    getOperationMock.mockReset()
    getOperationMock.mockResolvedValue({
      operationId: 'exec-1',
      status: 'running',
    })
    cancelOperationMock.mockReset()
    cancelOperationMock.mockResolvedValue({
      operationId: 'exec-1',
      status: 'cancelled',
    })
    appConsoleDataMock.hydrate.mockReset()
    appConsoleDataMock.hydrate.mockResolvedValue(undefined)
    appConsoleDataMock.startExternalExecution.mockReset()
    appConsoleDataMock.startExternalExecution.mockReturnValue({
      cellId: 'cell-1',
      source: "console.log('hello')",
    })
    appConsoleDataMock.appendStdout.mockReset()
    appConsoleDataMock.appendStderr.mockReset()
    appConsoleDataMock.completeExecution.mockReset()
    appConsoleDataMock.failExecution.mockReset()
    appLoggerMock.debug.mockReset()
    appLoggerMock.info.mockReset()
    appLoggerMock.error.mockReset()
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext
  })

  afterEach(() => {
    cleanup()
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext
  })

  it('skips registration when navigator.modelContext is unavailable', () => {
    render(<WebMcpToolRegistrationHost />)

    expect(appLoggerMock.debug).toHaveBeenCalledWith(
      'WebMCP unavailable; skipping tool registration',
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: 'webmcp',
        }),
      })
    )
  })

  it('registers WebMCP tools and unregisters them on cleanup', async () => {
    const registered: Array<{
      tool: {
        name: string
        title: string
        description: string
        inputSchema: Record<string, unknown>
        annotations: {
          readOnlyHint: boolean
          untrustedContentHint: boolean
        }
        execute: (input: Record<string, unknown>) => Promise<string> | string
      }
      signal?: AbortSignal
    }> = []
    const registerTool = vi.fn((tool, options?: { signal?: AbortSignal }) => {
      registered.push({
        tool,
        signal: options?.signal,
      })
    })
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool,
      },
    })

    const rendered = render(<WebMcpToolRegistrationHost />)

    expect(registerTool).toHaveBeenCalledTimes(8)
    expect(
      registered.some(({ tool }) => tool.name === 'listNotebookComments')
    ).toBe(false)
    const executeCode = registered.find(
      ({ tool }) => tool.name === 'ExecuteCode'
    )
    expect(executeCode?.tool.title).toBe('Runme Execute Code')
    expect(executeCode?.tool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    })
    expect(executeCode?.tool.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        timeoutMs: {
          type: 'integer',
          minimum: 1_000,
          maximum: 60_000,
          description:
            'Optional initial response wait budget in milliseconds. Defaults to 15000 and is capped at 60000. It is not the hard execution deadline.',
        },
        timeoutBehavior: {
          type: 'string',
          enum: ['continue', 'cancel'],
          default: 'continue',
          description:
            'What to do when timeoutMs expires. continue returns a running operation for later polling; cancel aborts the sandbox. Defaults to continue.',
        },
        maxRuntimeMs: {
          type: 'integer',
          minimum: 1_000,
          maximum: 3_600_000,
          default: 600_000,
          description:
            'Hard runtime limit for the operation in milliseconds. Defaults to 600000 and is capped at 3600000.',
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description:
            'Optional caller token for safely deduplicating a retried request. Runme still assigns the operationId.',
        },
      },
      required: ['code'],
    })

    await expect(
      executeCode?.tool.execute({
        code: "console.log('hello')",
        timeoutMs: 30_000,
      })
    ).resolves.toContain('"operationId":"exec-1"')
    expect(appConsoleDataMock.hydrate).toHaveBeenCalledTimes(1)
    expect(appConsoleDataMock.startExternalExecution).toHaveBeenCalledWith(
      "console.log('hello')"
    )
    expect(startOperationMock).toHaveBeenCalledWith({
      code: "console.log('hello')",
      timeoutMs: 30_000,
      hooks: {
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      },
      onAccepted: expect.any(Function),
      onSettled: expect.any(Function),
    })
    expect(appConsoleDataMock.appendStdout).toHaveBeenCalledWith(
      'cell-1',
      'stdout chunk'
    )
    expect(appConsoleDataMock.appendStderr).toHaveBeenCalledWith(
      'cell-1',
      'stderr chunk'
    )
    expect(appConsoleDataMock.completeExecution).toHaveBeenCalledWith(
      'cell-1',
      {
        exitCode: 0,
      }
    )
    expect(appConsoleDataMock.failExecution).not.toHaveBeenCalled()

    const getOperation = registered.find(
      ({ tool }) => tool.name === 'GetExecuteCodeOperation'
    )
    expect(getOperation?.tool.annotations.readOnlyHint).toBe(true)
    await getOperation?.tool.execute({
      operationId: 'exec-1',
      afterSequence: 2,
    })
    expect(getOperationMock).toHaveBeenCalledWith({
      operationId: 'exec-1',
      afterSequence: 2,
    })

    const cancelOperation = registered.find(
      ({ tool }) => tool.name === 'CancelExecuteCodeOperation'
    )
    expect(cancelOperation?.tool.annotations.readOnlyHint).toBe(false)
    await cancelOperation?.tool.execute({ operationId: 'exec-1' })
    expect(cancelOperationMock).toHaveBeenCalledWith({
      operationId: 'exec-1',
    })

    const instructions = registered.find(
      ({ tool }) => tool.name === 'readInstructionsForAIAgents'
    )
    expect(instructions?.tool.title).toBe(
      'Read Runme Instructions for AI Agents'
    )
    expect(instructions?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
    })
    expect(instructions?.tool.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    })
    expect(instructions?.tool.execute({})).toContain(window.location.origin)
    expect(instructions?.tool.execute({})).toContain('await app.getSessionID()')

    const listDocumentation = registered.find(
      ({ tool }) => tool.name === 'listDocumentation'
    )
    expect(listDocumentation?.tool.title).toBe('List Runme Documentation')
    expect(listDocumentation?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
    })
    expect(listDocumentation?.tool.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    })
    expect(JSON.parse(String(listDocumentation?.tool.execute({})))[0]).toEqual(
      expect.objectContaining({
        name: 'getting-started',
        description: expect.any(String),
      })
    )

    const getDocumentation = registered.find(
      ({ tool }) => tool.name === 'getDocumentation'
    )
    expect(getDocumentation?.tool.title).toBe('Get Runme Documentation')
    expect(getDocumentation?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
    })
    expect(getDocumentation?.tool.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    })
    await expect(getDocumentation?.tool.execute({})).rejects.toThrow(
      'non-empty name returned by listDocumentation'
    )

    const showTourStep = registered.find(
      ({ tool }) => tool.name === 'showTourStep'
    )
    expect(showTourStep?.tool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    })
    expect(
      JSON.parse(
        String(
          showTourStep?.tool.execute({
            target: 'left-nav.google-drive',
            message: 'Click here to connect Google Drive.',
          })
        )
      )
    ).toMatchObject({
      target: 'left-nav.google-drive',
      message: 'Click here to connect Google Drive.',
    })

    const dismissTour = registered.find(
      ({ tool }) => tool.name === 'dismissTour'
    )
    expect(JSON.parse(String(dismissTour?.tool.execute({})))).toEqual({
      dismissed: true,
    })

    expect(
      registered.some(({ tool }) => tool.name === 'startTourWorkflow')
    ).toBe(false)
    expect(
      registered.some(({ tool }) => tool.name === 'continueTourWorkflow')
    ).toBe(false)

    expect(registered.every(({ signal }) => signal?.aborted === false)).toBe(
      true
    )
    rendered.unmount()
    expect(registered.every(({ signal }) => signal?.aborted === true)).toBe(
      true
    )
  })

  it('does not create an AppConsole cell when ExecuteCode is rejected before acceptance', async () => {
    startOperationMock.mockRejectedValueOnce(new Error('boom'))
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(),
      },
    })

    render(<WebMcpToolRegistrationHost />)
    const registerTool = (
      navigator as Navigator & {
        modelContext?: { registerTool: ReturnType<typeof vi.fn> }
      }
    ).modelContext?.registerTool
    const registered = registerTool?.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === 'ExecuteCode')

    await expect(
      registered?.execute({
        code: "console.log('hello')",
      })
    ).rejects.toThrow('boom')

    expect(appConsoleDataMock.startExternalExecution).not.toHaveBeenCalled()
    expect(appConsoleDataMock.failExecution).not.toHaveBeenCalled()
  })

  it('marks the AppConsole cell failed when the operation settles unsuccessfully', async () => {
    startOperationMock.mockImplementationOnce(async (input) => {
      input.onAccepted?.('exec-2')
      const operation = {
        operationId: 'exec-2',
        status: 'failed',
        createdAt: '2026-08-16T00:00:00.000Z',
        completedAt: '2026-08-16T00:00:01.000Z',
        expiresAt: '2026-08-17T00:00:00.000Z',
        waitExpired: false,
        exitCode: 7,
        error: { code: 'EXECUTION_FAILED', message: 'boom' },
        output: {
          events: [],
          nextSequence: 0,
          latestSequence: 0,
          hasMore: false,
          truncated: false,
          droppedBytes: 0,
        },
      }
      input.onSettled?.(operation)
      return operation
    })
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(),
      },
    })

    render(<WebMcpToolRegistrationHost />)
    const registerTool = (
      navigator as Navigator & {
        modelContext?: { registerTool: ReturnType<typeof vi.fn> }
      }
    ).modelContext?.registerTool
    const registered = registerTool?.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === 'ExecuteCode')

    await expect(
      registered?.execute({
        code: "throw new Error('boom')",
      })
    ).resolves.toContain('"status":"failed"')

    expect(appConsoleDataMock.failExecution).toHaveBeenCalledWith('cell-1', {
      exitCode: 7,
      message: 'boom',
    })
    expect(appConsoleDataMock.completeExecution).not.toHaveBeenCalled()
  })
})
