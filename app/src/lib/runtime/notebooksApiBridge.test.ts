import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import {
  type NotebooksApiBridgeServer,
  createHostNotebooksApi,
  createNotebooksApiBridgeServer,
} from './notebooksApiBridge'
import type { NotebookDataLike, NotebooksApi } from './runmeConsole'

class FakeNotebookData implements NotebookDataLike {
  constructor(
    private readonly uri: string,
    private readonly name: string,
    private readonly notebook: parser_pb.Notebook
  ) {}

  getUri(): string {
    return this.uri
  }

  getName(): string {
    return this.name
  }

  getNotebook(): parser_pb.Notebook {
    return this.notebook
  }

  updateCell(cell: parser_pb.Cell): void {
    this.notebook.cells = (this.notebook.cells ?? []).map((existing) =>
      existing.refId === cell.refId
        ? create(parser_pb.CellSchema, cell)
        : existing
    )
  }

  getCell(): null {
    return null
  }

  appendCell(
    kind: parser_pb.CellKind = parser_pb.CellKind.CODE,
    languageId?: string | null
  ): parser_pb.Cell {
    const cell = this.createCell(kind, languageId)
    this.notebook.cells = [...(this.notebook.cells ?? []), cell]
    return cell
  }

  addCellAfter(
    targetRefId: string,
    kind: parser_pb.CellKind = parser_pb.CellKind.CODE,
    languageId?: string | null
  ): parser_pb.Cell | null {
    const cells = this.notebook.cells ?? []
    const index = cells.findIndex((cell) => cell.refId === targetRefId)
    if (index < 0) {
      return null
    }
    const cell = this.createCell(kind, languageId)
    const next = [...cells]
    next.splice(index + 1, 0, cell)
    this.notebook.cells = next
    return cell
  }

  addCellBefore(
    targetRefId: string,
    kind: parser_pb.CellKind = parser_pb.CellKind.CODE,
    languageId?: string | null
  ): parser_pb.Cell | null {
    const cells = this.notebook.cells ?? []
    const index = cells.findIndex((cell) => cell.refId === targetRefId)
    if (index < 0) {
      return null
    }
    const cell = this.createCell(kind, languageId)
    const next = [...cells]
    next.splice(index, 0, cell)
    this.notebook.cells = next
    return cell
  }

  removeCell(refId: string): void {
    this.notebook.cells = (this.notebook.cells ?? []).filter(
      (cell) => cell.refId !== refId
    )
  }

  private createCell(
    kind: parser_pb.CellKind,
    languageId?: string | null
  ): parser_pb.Cell {
    return create(parser_pb.CellSchema, {
      refId: `cell-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      languageId:
        languageId ??
        (kind === parser_pb.CellKind.MARKUP ? 'markdown' : 'bash'),
      value: '',
      outputs: [],
      metadata: {},
    })
  }
}

function codeCellWithBigIntTiming(): parser_pb.Cell {
  const cell = create(parser_pb.CellSchema, {
    refId: 'cell-a',
    kind: parser_pb.CellKind.CODE,
    languageId: 'bash',
    value: 'echo a',
    outputs: [],
    metadata: {},
  })
  ;(cell as any).executionSummary = {
    success: true,
    timing: {
      startTime: 1700000000000n,
      endTime: 1700000001000n,
    },
  }
  return cell
}

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
    ).rejects.toThrow(
      'Unsupported sandbox NotebooksApi method: notebooks.unknown'
    )
  })

  it('delegates notebook reference helper RPCs when provided', async () => {
    const resolve = vi.fn(async () => ({
      uri: 'local://file/demo',
      title: 'demo',
    }))
    const bridgeServer = createBridgeServer({
      resolve,
    } as Partial<NotebooksApi>)

    await expect(
      bridgeServer.handleMessage({
        method: 'notebooks.resolve',
        args: ['local://file/demo'],
      })
    ).resolves.toEqual({
      uri: 'local://file/demo',
      title: 'demo',
    })
    expect(resolve).toHaveBeenCalledWith('local://file/demo')
  })

  it('returns JSON-safe get and update results for notebooks with BigInt timing fields', async () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [codeCellWithBigIntTiming()],
    })
    const model = new FakeNotebookData(
      'local://file/bigint',
      'bigint.json',
      notebook
    )
    const bridgeServer = createNotebooksApiBridgeServer({
      notebooksApi: createHostNotebooksApi({
        resolveNotebook: (target?: unknown) =>
          target === undefined || target === 'local://file/bigint'
            ? model
            : null,
        listNotebooks: () => [model],
      }),
    })

    const document = await bridgeServer.handleMessage({
      method: 'notebooks.get',
      args: [{ uri: 'local://file/bigint' }],
    })
    const updated = await bridgeServer.handleMessage({
      method: 'notebooks.update',
      args: [
        {
          target: { uri: 'local://file/bigint' },
          operations: [
            {
              op: 'insert',
              at: { index: -1 },
              cells: [
                { kind: 'markup', languageId: 'markdown', value: 'test' },
              ],
            },
          ],
        },
      ],
    })

    expect(JSON.stringify(document)).toContain('"startTime":"1700000000000"')
    expect(JSON.stringify(updated)).toContain('"endTime":"1700000001000"')
    expect((updated as any).notebook.cells).toHaveLength(2)
  })
})
