import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type LocalNotebooks from '../../storage/local'
import { NotebookStoreProvider } from '../../contexts/NotebookStoreContext'
import { computeNotebookDiff } from '../../lib/notebookDiff/diff'
import { NotebookDiffContent } from './NotebookDiffView'

function notebook(value: string) {
  return create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        refId: 'cell-1',
        kind: parser_pb.CellKind.CODE,
        languageId: 'python',
        value,
      }),
    ],
    metadata: {},
  })
}

function serialize(notebookValue: parser_pb.Notebook): string {
  return toJsonString(parser_pb.NotebookSchema, notebookValue, {
    emitDefaultValues: true,
  } as unknown as Parameters<typeof toJsonString>[2])
}

describe('NotebookDiffContent', () => {
  it('renders a registered side-by-side diff document', () => {
    const diff = computeNotebookDiff(
      notebook("print('base')"),
      notebook("print('compare')")
    )
    const doc = {
      id: 'diff-1',
      base: { label: 'Drive revision 1', revisionId: '1' },
      compare: { label: 'Local copy', revisionId: 'local' },
      diff,
    }

    render(<NotebookDiffContent document={doc} />)

    expect(screen.getByText('Notebook Diff')).toBeTruthy()
    expect(
      screen.getByText(/Drive revision 1 compared with Local copy/)
    ).toBeTruthy()
    expect(screen.getByText('Base: Drive revision 1')).toBeTruthy()
    expect(screen.getByText('Compare: Local copy')).toBeTruthy()
    expect(screen.getByText("print('base')")).toBeTruthy()
    expect(screen.getByText("print('compare')")).toBeTruthy()
  })

  it('renders unchanged cell contents inside the expandable row', () => {
    const diff = computeNotebookDiff(
      notebook("print('same')"),
      notebook("print('same')")
    )
    const doc = {
      id: 'diff-1',
      base: { label: 'Drive revision 1', revisionId: '1' },
      compare: { label: 'Local copy', revisionId: 'local' },
      diff,
    }

    render(<NotebookDiffContent document={doc} />)

    expect(screen.getByText('Unchanged cell cell-1')).toBeTruthy()
    expect(screen.getAllByText("print('same')")).toHaveLength(2)
  })

  it('shows an insert affordance for upstream cells deleted locally', () => {
    const diff = computeNotebookDiff(
      create(parser_pb.NotebookSchema, {
        cells: [
          create(parser_pb.CellSchema, {
            refId: 'remote-only',
            kind: parser_pb.CellKind.CODE,
            languageId: 'python',
            value: "print('restore me')",
          }),
        ],
        metadata: {},
      }),
      create(parser_pb.NotebookSchema, {
        cells: [],
        metadata: {},
      })
    )
    const doc = {
      id: 'conflict-diff',
      base: { label: 'Upstream version', revisionId: 'upstream' },
      compare: { label: 'Local version' },
      diff,
      resolution: {
        kind: 'notebook-sync-conflict' as const,
        localUri: 'local://file/conflict',
      },
    }

    render(
      <NotebookStoreProvider initialStore={{} as unknown as LocalNotebooks}>
        <NotebookDiffContent document={doc} />
      </NotebookStoreProvider>
    )

    expect(
      screen.getByRole('button', {
        name: 'Insert upstream cell into local notebook',
      })
    ).toBeTruthy()
  })

  it('loads an older Drive revision from the Base revision selector', async () => {
    const upstreamNotebook = notebook("print('upstream')")
    const olderNotebook = notebook("print('older')")
    const localNotebook = notebook("print('local')")
    const localUri = 'local://file/conflict'
    const record = {
      id: localUri,
      name: 'conflict.json',
      doc: serialize(localNotebook),
      conflict: {
        detectedAt: '2026-06-01T00:00:00.000Z',
        upstreamChecksum: 'upstream',
        upstreamVersion: { revisionId: 'revision-2' },
        localChecksumAtDetection: 'local',
      },
    }
    const localStore = {
      files: {
        get: vi.fn(async () => record),
      },
      getConflictUpstreamDoc: vi.fn(async () => serialize(upstreamNotebook)),
      getDriveRevisionDoc: vi.fn(async () => serialize(olderNotebook)),
      listDriveRevisions: vi.fn(async () => [
        {
          id: 'revision-2',
          modifiedTime: '2026-06-14T20:00:00.000Z',
        },
        {
          id: 'revision-1',
          modifiedTime: '2026-06-14T19:00:00.000Z',
        },
      ]),
    } as unknown as LocalNotebooks
    const doc = {
      id: 'conflict-diff',
      base: { label: 'Upstream version', revisionId: 'revision-2' },
      compare: { label: 'Local version' },
      diff: computeNotebookDiff(upstreamNotebook, localNotebook, {
        includeMetadata: true,
        includeOutputs: true,
      }),
      resolution: {
        kind: 'notebook-sync-conflict' as const,
        localUri,
      },
    }

    render(
      <NotebookStoreProvider initialStore={localStore}>
        <NotebookDiffContent document={doc} />
      </NotebookStoreProvider>
    )

    const selector = await screen.findByLabelText('Compare against')
    fireEvent.change(selector, { target: { value: 'revision-1' } })

    await waitFor(() => {
      expect(localStore.getDriveRevisionDoc).toHaveBeenCalledWith(
        localUri,
        'revision-1'
      )
    })
  })

  it('inserts a deleted upstream cell into the local notebook and refreshes the diff', async () => {
    const upstreamNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'remote-only',
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('restore me')",
        }),
      ],
      metadata: {},
    })
    const localNotebook = create(parser_pb.NotebookSchema, {
      cells: [],
      metadata: {},
    })
    let record = {
      id: 'local://file/conflict',
      name: 'conflict.json',
      doc: serialize(localNotebook),
      conflict: {
        detectedAt: '2026-06-01T00:00:00.000Z',
        upstreamChecksum: 'upstream',
        localChecksumAtDetection: 'local',
      },
    }
    const localStore = {
      files: {
        get: vi.fn(async () => record),
      },
      getConflictUpstreamDoc: vi.fn(async () => serialize(upstreamNotebook)),
      save: vi.fn(async (_localUri: string, saved: parser_pb.Notebook) => {
        record = {
          ...record,
          doc: serialize(saved),
        }
      }),
    } as unknown as LocalNotebooks
    const doc = {
      id: 'conflict-diff',
      base: { label: 'Upstream version', revisionId: 'upstream' },
      compare: { label: 'Local version' },
      diff: computeNotebookDiff(upstreamNotebook, localNotebook, {
        includeMetadata: true,
        includeOutputs: true,
      }),
      resolution: {
        kind: 'notebook-sync-conflict' as const,
        localUri: 'local://file/conflict',
      },
    }

    render(
      <NotebookStoreProvider initialStore={localStore}>
        <NotebookDiffContent document={doc} />
      </NotebookStoreProvider>
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Insert upstream cell into local notebook',
      })
    )

    await waitFor(() => {
      expect(localStore.save).toHaveBeenCalledTimes(1)
      expect(
        screen.queryByRole('button', {
          name: 'Insert upstream cell into local notebook',
        })
      ).toBeNull()
    })
    const savedNotebook = fromJsonString(parser_pb.NotebookSchema, record.doc, {
      ignoreUnknownFields: true,
    })
    expect(savedNotebook.cells.map((cell) => cell.refId)).toEqual([
      'remote-only',
    ])
    expect(screen.getByText('0 deleted')).toBeTruthy()
  })
})
