// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import { createHostNotebooksApi } from './notebooksApiBridge'
import { createCodeModeNotebookAdapter } from './useCodeModeExecutor'

describe('createCodeModeNotebookAdapter', () => {
  it('forwards generic cell insertion methods for AppKernel notebook updates', async () => {
    const notebook = create(parser_pb.NotebookSchema, { cells: [] })
    const source = {
      getUri: () => 'local://adapter-test.runme.md',
      getName: () => 'adapter-test.runme.md',
      getNotebook: () => notebook,
      updateCell: vi.fn((cell: parser_pb.Cell) => {
        notebook.cells = (notebook.cells ?? []).map((existing) =>
          existing.refId === cell.refId
            ? create(parser_pb.CellSchema, cell)
            : existing
        )
      }),
      getCell: () => null,
      appendCell: vi.fn(
        (
          kind: parser_pb.CellKind = parser_pb.CellKind.CODE,
          languageId?: string | null
        ) => {
          const cell = create(parser_pb.CellSchema, {
            refId: kind === parser_pb.CellKind.MARKUP ? 'markup-a' : 'code-a',
            kind,
            languageId:
              languageId ?? (kind === parser_pb.CellKind.MARKUP ? 'markdown' : 'javascript'),
            value: '',
            outputs: [],
            metadata: {},
          })
          notebook.cells = [...(notebook.cells ?? []), cell]
          return cell
        }
      ),
      addCellAfter: vi.fn(),
      addCellBefore: vi.fn(),
      removeCell: vi.fn((refId: string) => {
        notebook.cells = (notebook.cells ?? []).filter(
          (cell) => cell.refId !== refId
        )
      }),
      flushPendingPersist: vi.fn(async () => undefined),
      loadNotebook: vi.fn(),
    }
    const adapter = createCodeModeNotebookAdapter(source)
    const notebooks = createHostNotebooksApi({
      resolveNotebook: () => adapter,
      listNotebooks: () => [adapter],
    })

    const before = await notebooks.get({ uri: source.getUri() })
    const updated = await notebooks.update({
      target: { handle: before.handle },
      expectedRevision: before.handle.revision,
      operations: [
        {
          op: 'insert',
          at: { index: -1 },
          cells: [
            {
              kind: 'markup',
              languageId: 'markdown',
              value: '# Inserted from AppKernel',
            },
          ],
        },
      ],
    })

    expect(source.appendCell).toHaveBeenCalledWith(
      parser_pb.CellKind.MARKUP,
      'markdown'
    )
    expect(updated.notebook.cells).toHaveLength(1)
    expect(updated.notebook.cells[0]?.kind).toBe(parser_pb.CellKind.MARKUP)
    expect(updated.notebook.cells[0]?.refId).toBe('markup-a')

    const restoredNotebook = create(parser_pb.NotebookSchema, { cells: [] })
    await adapter.flushPendingPersist?.()
    adapter.loadNotebook?.(restoredNotebook, { persist: false })

    expect(source.flushPendingPersist).toHaveBeenCalledTimes(1)
    expect(source.loadNotebook).toHaveBeenCalledWith(restoredNotebook, {
      persist: false,
    })
  })
})
