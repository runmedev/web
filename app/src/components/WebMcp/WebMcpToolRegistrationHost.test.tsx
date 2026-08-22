// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const {
  executeMock,
  startOperationMock,
  getOperationMock,
  cancelOperationMock,
  createDriveNotebookMock,
  searchDriveFilesMock,
  mountDriveFolderMock,
  startGoogleDriveOAuthMock,
  appConsoleDataMock,
  appLoggerMock,
} = vi.hoisted(() => ({
  executeMock: vi.fn(),
  startOperationMock: vi.fn(),
  getOperationMock: vi.fn(),
  cancelOperationMock: vi.fn(),
  createDriveNotebookMock: vi.fn(),
  searchDriveFilesMock: vi.fn(),
  mountDriveFolderMock: vi.fn(),
  startGoogleDriveOAuthMock: vi.fn(),
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

vi.mock('../../lib/driveTransfer', () => ({
  createDriveNotebook: createDriveNotebookMock,
  searchDriveFiles: searchDriveFilesMock,
  mountDriveFolder: mountDriveFolderMock,
}))

vi.mock('../../lib/logging/runtime', () => ({
  appLogger: appLoggerMock,
}))

vi.mock('../../lib/runtime/AppState', () => ({
  appState: {
    startGoogleDriveOAuth: startGoogleDriveOAuthMock,
  },
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
    createDriveNotebookMock.mockReset()
    createDriveNotebookMock.mockResolvedValue({
      fileId: 'drive-file-1',
      fileName: 'demo.ipynb',
      remoteUri: 'https://drive.google.com/file/d/drive-file-1/view',
      localUri: 'local://file/drive-file-1',
    })
    searchDriveFilesMock.mockReset()
    searchDriveFilesMock.mockResolvedValue({
      files: [
        {
          id: 'drive-folder-1',
          name: 'notebooks',
          mimeType: 'application/vnd.google-apps.folder',
          uri: 'https://drive.google.com/drive/folders/drive-folder-1',
        },
      ],
    })
    mountDriveFolderMock.mockReset()
    mountDriveFolderMock.mockResolvedValue({
      folderId: 'drive-folder-1',
      name: 'notebooks',
      remoteUri: 'https://drive.google.com/drive/folders/drive-folder-1',
      localUri: 'local://folder/drive-folder-1',
      alreadyMounted: false,
    })
    startGoogleDriveOAuthMock.mockReset()
    startGoogleDriveOAuthMock.mockResolvedValue({
      status: 'authorized',
      authFlow: 'implicit',
      mode: 'popup',
      accessToken: 'access-token',
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
    delete (document as Document & { modelContext?: unknown }).modelContext
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext
  })

  afterEach(() => {
    cleanup()
    delete (document as Document & { modelContext?: unknown }).modelContext
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext
  })

  it('skips registration when modelContext is unavailable', () => {
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

  it('falls back to the legacy navigator.modelContext API', () => {
    const registerTool = vi.fn()
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: { registerTool },
    })

    render(<WebMcpToolRegistrationHost />)

    expect(registerTool).toHaveBeenCalledTimes(12)
  })

  it('prefers the current document.modelContext API', () => {
    const documentRegisterTool = vi.fn()
    const navigatorRegisterTool = vi.fn()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool: documentRegisterTool },
    })
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: { registerTool: navigatorRegisterTool },
    })

    render(<WebMcpToolRegistrationHost />)

    expect(documentRegisterTool).toHaveBeenCalledTimes(12)
    expect(navigatorRegisterTool).not.toHaveBeenCalled()
  })

  it('reports asynchronous registration failures', async () => {
    const registerTool = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('not allowed', 'NotAllowedError'))
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool },
    })

    render(<WebMcpToolRegistrationHost />)

    await waitFor(() => {
      expect(appLoggerMock.error).toHaveBeenCalledWith(
        'Failed to register WebMCP tools',
        expect.objectContaining({
          attrs: expect.objectContaining({
            scope: 'webmcp',
            error: 'NotAllowedError: not allowed',
          }),
        })
      )
    })
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
        execute: (
          input: Record<string, unknown>,
          options?: { signal?: AbortSignal }
        ) => Promise<string> | string
      }
      signal?: AbortSignal
    }> = []
    const registerTool = vi.fn((tool, options?: { signal?: AbortSignal }) => {
      registered.push({
        tool,
        signal: options?.signal,
      })
    })
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool,
      },
    })

    const rendered = render(<WebMcpToolRegistrationHost />)

    expect(registerTool).toHaveBeenCalledTimes(12)
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
        code: {
          type: 'string',
          description:
            'AppKernel JavaScript. For notebook reads, use await notebooks.get({ uri }) and doc.notebook.cells. Do not call notebooks.read; it does not exist. Use await notebooks.help() to inspect the live API.',
        },
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
    expect(getOperation?.tool.inputSchema).toMatchObject({
      properties: {
        maxBytes: {
          minimum: 16_384,
          maximum: 262_144,
        },
      },
    })
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
    expect(cancelOperation?.tool.inputSchema).toMatchObject({
      properties: {
        maxBytes: {
          minimum: 16_384,
          maximum: 262_144,
        },
      },
    })
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

    const searchDriveItems = registered.find(
      ({ tool }) => tool.name === 'searchDriveItems'
    )
    expect(searchDriveItems?.tool.title).toBe('Search Google Drive Items')
    expect(searchDriveItems?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    })
    expect(searchDriveItems?.tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['name'],
      properties: {
        itemType: { enum: ['any', 'file', 'folder'] },
        pageSize: { minimum: 1, maximum: 100 },
      },
    })
    await expect(
      searchDriveItems?.tool.execute({
        name: 'notebooks',
        itemType: 'folder',
        exactName: true,
      })
    ).resolves.toContain('"name":"notebooks"')
    expect(searchDriveFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining("name = 'notebooks'"),
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      })
    )

    const listDriveFolder = registered.find(
      ({ tool }) => tool.name === 'listDriveFolder'
    )
    expect(listDriveFolder?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    })
    await expect(
      listDriveFolder?.tool.execute({ folderIdOrUri: 'drive-folder-1' })
    ).resolves.toContain(
      '"folderUri":"https://drive.google.com/drive/folders/drive-folder-1"'
    )

    const mountDriveFolder = registered.find(
      ({ tool }) => tool.name === 'mountDriveFolder'
    )
    expect(mountDriveFolder?.tool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    })
    await expect(
      mountDriveFolder?.tool.execute({ folderIdOrUri: 'drive-folder-1' })
    ).resolves.toContain('"localUri":"local://folder/drive-folder-1"')
    expect(mountDriveFolderMock).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/drive-folder-1'
    )

    const createDriveNotebook = registered.find(
      ({ tool }) => tool.name === 'createDriveNotebook'
    )
    expect(createDriveNotebook?.tool.title).toBe('Create Google Drive Notebook')
    expect(createDriveNotebook?.tool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    })
    expect(createDriveNotebook?.tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['folderIdOrUri', 'fileName', 'idempotencyKey'],
      properties: {
        folderIdOrUri: { type: 'string', minLength: 1 },
        fileName: { type: 'string', minLength: 1 },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
        cells: { type: 'array' },
      },
    })
    await expect(
      createDriveNotebook?.tool.execute({
        folderIdOrUri: 'root',
        fileName: 'demo.ipynb',
        idempotencyKey: 'create-demo-notebook',
        cells: [{ kind: 'markup', value: '# Demo' }],
      })
    ).resolves.toContain('"fileId":"drive-file-1"')
    expect(createDriveNotebookMock).toHaveBeenCalledWith('root', 'demo.ipynb', {
      idempotencyKey: 'create-demo-notebook',
      cells: [{ kind: 'markup', value: '# Demo' }],
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

  it('cancels an accepted ExecuteCode operation when WebMCP aborts', async () => {
    let resolveStart:
      | ((operation: { operationId: string; status: string }) => void)
      | undefined
    startOperationMock.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          resolveStart = resolve
          input.onAccepted?.('exec-aborted')
        })
    )
    cancelOperationMock.mockImplementationOnce(async () => {
      const operation = {
        operationId: 'exec-aborted',
        status: 'cancelled',
      }
      resolveStart?.(operation)
      return operation
    })
    const registerTool = vi.fn()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool },
    })

    render(<WebMcpToolRegistrationHost />)
    const executeCode = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === 'ExecuteCode')
    const controller = new AbortController()
    const execution = executeCode.execute(
      { code: 'await new Promise(() => {})' },
      { signal: controller.signal }
    )

    await waitFor(() => expect(startOperationMock).toHaveBeenCalledTimes(1))
    controller.abort(new DOMException('Cancelled', 'AbortError'))

    await waitFor(() => {
      expect(cancelOperationMock).toHaveBeenCalledWith({
        operationId: 'exec-aborted',
      })
    })
    await expect(execution).resolves.toContain('"status":"cancelled"')
  })

  it('does not create an AppConsole cell when ExecuteCode is rejected before acceptance', async () => {
    startOperationMock.mockRejectedValueOnce(new Error('boom'))
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(),
      },
    })

    render(<WebMcpToolRegistrationHost />)
    const registerTool = (
      document as Document & {
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

  it('requests user interaction when Drive authorization is required', async () => {
    createDriveNotebookMock
      .mockRejectedValueOnce(
        new Error('Google Drive authorization is required.')
      )
      .mockResolvedValueOnce({
        fileId: 'drive-file-1',
        fileName: 'demo.ipynb',
        remoteUri: 'https://drive.google.com/file/d/drive-file-1/view',
        localUri: 'local://file/drive-file-1',
      })
    const registerTool = vi.fn()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool },
    })

    render(<WebMcpToolRegistrationHost />)
    const createDriveNotebook = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === 'createDriveNotebook')
    const requestUserInteraction = vi.fn(async (callback) => callback())
    const input = {
      folderIdOrUri: 'root',
      fileName: 'demo.ipynb',
      idempotencyKey: 'create-demo-notebook',
    }

    await expect(
      createDriveNotebook.execute(input, { requestUserInteraction })
    ).resolves.toContain('"fileId":"drive-file-1"')

    expect(requestUserInteraction).toHaveBeenCalledTimes(1)
    expect(startGoogleDriveOAuthMock).toHaveBeenCalledWith({ mode: 'popup' })
    expect(createDriveNotebookMock).toHaveBeenCalledTimes(2)
    expect(createDriveNotebookMock).toHaveBeenNthCalledWith(
      2,
      'root',
      'demo.ipynb',
      { idempotencyKey: 'create-demo-notebook' }
    )
  })

  it('preserves the Drive authorization error when interaction is unavailable', async () => {
    searchDriveFilesMock.mockRejectedValueOnce(
      new Error('Google Drive authorization is required.')
    )
    const registerTool = vi.fn()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool },
    })

    render(<WebMcpToolRegistrationHost />)
    const searchDriveItems = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === 'searchDriveItems')

    await expect(
      searchDriveItems.execute({ name: 'notebooks', itemType: 'folder' })
    ).rejects.toThrow('Google Drive authorization is required.')
  })

  it('keeps idempotency guidance when Drive authorization is incomplete', async () => {
    createDriveNotebookMock.mockRejectedValueOnce(
      new Error('Google Drive authorization is required.')
    )
    startGoogleDriveOAuthMock.mockResolvedValueOnce({
      status: 'pending',
      authFlow: 'implicit',
      mode: 'popup',
    })
    const registerTool = vi.fn()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool },
    })

    render(<WebMcpToolRegistrationHost />)
    const createDriveNotebook = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === 'createDriveNotebook')

    await expect(
      createDriveNotebook.execute(
        {
          folderIdOrUri: 'root',
          fileName: 'demo.ipynb',
          idempotencyKey: 'create-demo-notebook',
        },
        { requestUserInteraction: async (callback) => callback() }
      )
    ).rejects.toThrow('retry createDriveNotebook with the same idempotencyKey')
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
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(),
      },
    })

    render(<WebMcpToolRegistrationHost />)
    const registerTool = (
      document as Document & {
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
