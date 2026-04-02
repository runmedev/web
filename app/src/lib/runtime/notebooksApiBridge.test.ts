import { describe, expect, it, vi } from 'vitest'

import {
  createNotebooksApiBridgeServer,
  type NotebooksApiBridgeServer,
} from './notebooksApiBridge'
import type { NotebooksApi } from './runmeConsole'

function createBridgeServer(
  overrides: Partial<NotebooksApi> = {}
): NotebooksApiBridgeServer {
  const notebooksApi: NotebooksApi = {
    help: vi.fn(async () => 'help text'),
    list: vi.fn(async () => []),
    get: vi.fn(async () => {
      throw new Error('not implemented')
    }),
    update: vi.fn(async () => {
      throw new Error('not implemented')
    }),
    delete: vi.fn(async () => {}),
    execute: vi.fn(async () => {
      throw new Error('not implemented')
    }),
    ...overrides,
  }

  return createNotebooksApiBridgeServer({
    notebooksApi,
  })
}

describe('createNotebooksApiBridgeServer', () => {
  it('delegates sandbox notebook RPCs to the host NotebooksApi implementation', async () => {
    const list = vi.fn(async () => [
      {
        uri: 'local://file/demo',
        name: 'demo.json',
        isOpen: true,
        source: 'local' as const,
      },
    ])
    const bridgeServer = createBridgeServer({ list })

    await expect(
      bridgeServer.handleMessage({
        method: 'notebooks.list',
        args: [{ openOnly: true }],
      })
    ).resolves.toEqual([
      {
        uri: 'local://file/demo',
        name: 'demo.json',
        isOpen: true,
        source: 'local',
      },
    ])
    expect(list).toHaveBeenCalledWith({ openOnly: true })
  })

  it('rejects unknown notebook RPC methods', async () => {
    const bridgeServer = createBridgeServer()

    await expect(
      bridgeServer.handleMessage({
        method: 'notebooks.unknown',
        args: [],
      })
    ).rejects.toThrow('Unsupported sandbox NotebooksApi method: notebooks.unknown')
  })
})
