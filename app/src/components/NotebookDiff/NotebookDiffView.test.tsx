import { create } from '@bufbuild/protobuf'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parser_pb } from '../../runme/client'
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
})
