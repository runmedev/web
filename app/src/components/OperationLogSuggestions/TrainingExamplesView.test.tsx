import '@testing-library/jest-dom/vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type LocalNotebooks from '../../storage/local'
import type { NotebookSnapshot } from '../../lib/notebookData'
import { create } from '@bufbuild/protobuf'
import { parser_pb } from '../../runme/client'
import { exampleJournal } from '../../lib/trainingExamples/fixtures.test-helper'
import { extractExamples } from '../../lib/trainingExamples/model'
import { previewExample } from '../../lib/trainingExamples/preview'
import type {
  ExampleIndex,
  ExamplePreview,
} from '../../lib/trainingExamples/protocol'
import { TrainingExamplesView } from './TrainingExamplesView'
import { setExampleSelection } from '../../lib/trainingExamples/registry'

const api = vi.hoisted(() => ({
  load: vi.fn(),
  preview: vi.fn(),
  flush: vi.fn(async () => {}),
  snapshot: vi.fn<() => NotebookSnapshot | undefined>(() => undefined),
}))
vi.mock('../../lib/trainingExamples/client', () => ({
  loadTrainingExamples: api.load,
  loadTrainingExamplePreview: api.preview,
}))
vi.mock('../../lib/notebookDataController', () => ({
  getNotebookDataController: () => ({
    getNotebookData: () => ({
      flushPendingPersist: api.flush,
      getSnapshot: api.snapshot,
    }),
  }),
}))
const store = {
  loadOperationLogSnapshot: vi.fn(async () => ({ cells: [] })),
  trainingExampleJob: vi.fn(async (localUri) => ({
    localUri,
    sourcePath: 'test',
    name: 'test.runme',
  })),
} as unknown as LocalNotebooks

function fixture() {
  const j = exampleJournal()
  j.cell('a', 'original', true)
  j.cell('a', 'improved')
  j.name('positive')
  const start = j.name('start')
  j.cell('a', 'regression')
  const end = j.name('end')
  j.decide(start, end, 'a', 'undo')
  const result: ExampleIndex = {
    ...extractExamples(j.operations, 'test'),
    ruleVersion: 'test',
    sourceChecksum: 'test',
  }
  result.issues = [{ recordIds: ['test'], reason: 'Test diagnostic' }]
  // Sort only this fixture so assertions exercise both labels independent of IDs.
  result.examples.sort((a, b) => Number(b.accepted) - Number(a.accepted))
  api.load.mockResolvedValue(result)
  api.preview.mockImplementation(async (example) =>
    previewExample(j.operations, example)
  )
  return { result, j }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.snapshot.mockReturnValue(undefined)
})

describe('training examples viewer', () => {
  it('focuses the moved operation target rather than a displaced neighbor', async () => {
    const j = exampleJournal()
    j.cell('a', 'moved target', true)
    j.cell('b', 'displaced neighbor', true, 200)
    j.name('before')
    j.append('cell.move', { cell_id: 'a', position: [[300, 'test', 1]] })
    j.name('after')
    const result = extractExamples(j.operations, 'test')
    result.examples = result.examples.filter((e) =>
      e.diff.some((op) => 'kind' in op && op.kind === 'cell.move')
    )
    api.load.mockResolvedValue(result)
    api.preview.mockImplementation(async (example) =>
      previewExample([], example)
    )
    const { container } = render(
      <TrainingExamplesView docUri="local://file/test" store={store} />
    )
    await waitFor(() =>
      expect(container.querySelector('[data-example-focus]')).toHaveTextContent(
        'moved target'
      )
    )
    expect(
      container.querySelector('[data-example-focus]')
    ).not.toHaveTextContent('displaced neighbor')
  })
  it('scrolls to the selected example change after its preview renders', async () => {
    fixture()
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return {
          top: this.hasAttribute('data-example-focus') ? 900 : 100,
        } as DOMRect
      })
    try {
      const { container } = render(
        <TrainingExamplesView docUri="local://file/test" store={store} />
      )
      const pane = container.querySelector(
        '#training-examples-diff'
      ) as HTMLElement
      const scroll = vi.fn()
      pane.scrollTo = scroll
      await waitFor(() =>
        expect(scroll).toHaveBeenCalledWith({ top: 788, behavior: 'instant' })
      )
      expect(container.querySelector('[data-example-focus]')).toHaveAttribute(
        'aria-label',
        'inserted cell'
      )
      scroll.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Next example' }))
      await screen.findByRole('heading', { name: 'Example 2 · Rejected' })
      await waitFor(() =>
        expect(scroll).toHaveBeenCalledWith({ top: 788, behavior: 'instant' })
      )
      expect(container.querySelector('[data-example-focus]')).toHaveAttribute(
        'aria-label',
        'modified cell'
      )
    } finally {
      rect.mockRestore()
    }
  })
  it('orders cells by document position and labels them using first content lines', async () => {
    const { result } = fixture()
    result.examples = ['b', 'gone', 'a', 'empty'].map((id) => ({
      ...result.examples[0],
      id,
      provenance: { ...result.examples[0].provenance, cellIds: [id] },
    }))
    api.snapshot.mockReturnValue({
      uri: 'local://file/test',
      name: 'test.runme',
      loaded: true,
      notebook: create(parser_pb.NotebookSchema, {
        cells: [
          create(parser_pb.CellSchema, {
            refId: 'a',
            kind: parser_pb.CellKind.MARKUP,
            value: '\n## Introduction ###\nMore text',
          }),
          create(parser_pb.CellSchema, {
            refId: 'unassessed',
            value: 'Context',
          }),
          create(parser_pb.CellSchema, {
            refId: 'b',
            value: '// Query logs\nfetchLogs()',
          }),
          create(parser_pb.CellSchema, { refId: 'empty', value: '' }),
        ],
      }),
    })
    render(<TrainingExamplesView docUri="local://file/test" store={store} />)
    await screen.findByText('1 / 4')
    const options = within(
      screen.getByLabelText('Filter by cell')
    ).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'All cells',
      'Cell 1 · Introduction',
      'Cell 3 · Query logs',
      'Cell 4 · Untitled cell',
      'Unavailable cell · gone',
    ])
    fireEvent.change(screen.getByLabelText('Filter by cell'), {
      target: { value: (options[1] as HTMLOptionElement).value },
    })
    await screen.findByText('1 / 1')
    expect(api.preview.mock.calls.at(-1)?.[0].provenance.cellIds).toEqual(['a'])
  })
  it('shows a recipe-selected list without extracting or writing on open', async () => {
    const { result } = fixture()
    const uri = 'local://file/recipe'
    const chosen = result.examples.slice(0, 1)
    setExampleSelection(uri, {
      examples: chosen,
      jobs: {
        [chosen[0].id]: {
          localUri: 'local://file/other-source',
          sourcePath: 'test',
          name: 'other.runme',
        },
      },
    })
    render(<TrainingExamplesView docUri={uri} store={store} />)
    await screen.findByRole('heading', { name: 'Example 1 · Accepted' })
    expect(api.load).not.toHaveBeenCalled()
    expect(api.preview.mock.calls[0][0]).toEqual(chosen[0])
    expect(store.trainingExampleJob).not.toHaveBeenCalled()
    expect(screen.getByText('1 / 1')).toBeTruthy()
  })
  it('keeps the same cell ID in two source notebooks as separate filters', async () => {
    const { result } = fixture()
    const first = result.examples[0]
    const second = {
      ...first,
      id: 'second-source',
      provenance: {
        ...first.provenance,
        source: { driveFileId: 'second-drive' },
      },
    }
    const uri = 'local://file/shared-cell-id'
    setExampleSelection(uri, {
      examples: [first, second],
      jobs: {
        [first.id]: {
          localUri: 'local://file/one',
          sourcePath: 'one',
          name: 'one.runme',
        },
        [second.id]: {
          localUri: 'local://file/two',
          sourcePath: 'two',
          name: 'two.runme',
        },
      },
    })
    render(<TrainingExamplesView docUri={uri} store={store} />)
    await screen.findByText('1 / 2')
    const select = screen.getByLabelText('Filter by cell')
    const options = within(select).getAllByRole('option') as HTMLOptionElement[]
    expect(options).toHaveLength(3)
    expect(options[1].textContent).toContain('one.runme')
    expect(options[2].textContent).toContain('two.runme')
    fireEvent.change(select, { target: { value: options[2].value } })
    await screen.findByText('1 / 1')
    expect(api.preview.mock.calls.at(-1)?.[0].id).toBe('second-source')
  })
  it('navigates all examples with the corresponding label and real review cell diff', async () => {
    fixture()
    render(<TrainingExamplesView docUri="local://file/test" store={store} />)
    await screen.findByRole('heading', { name: 'Example 1 · Accepted' })
    expect(api.flush).toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Previous example' })
    ).toBeDisabled()
    expect(
      screen.getByRole('heading', { name: 'Example 1 · Accepted' })
    ).toBeTruthy()
    expect(screen.getByText('Label source: named-revision')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next example' }))
    await screen.findByRole('heading', { name: 'Example 2 · Rejected' })
    expect(screen.getByText('Label source: cell-decision')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next example' })).toBeDisabled()
    expect(api.preview).toHaveBeenCalledTimes(2)
    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse examples panel' })
    )
    expect(
      screen.getByRole('button', { name: 'Expand examples panel' })
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'Example 2 · Rejected' })
    ).toBeTruthy()
  })
  it('filters a recipe by notebook and cell while keeping labels attached to diffs', async () => {
    const { result } = fixture()
    const another = {
      ...result.examples[0],
      id: 'another-example',
      provenance: {
        ...result.examples[0].provenance,
        source: { driveFileId: 'another' },
        cellIds: ['b'],
      },
    }
    const uri = 'local://file/filtered-recipe'
    setExampleSelection(uri, {
      examples: [...result.examples, another],
      jobs: {},
    })
    render(<TrainingExamplesView docUri={uri} store={store} />)
    await screen.findByText('1 / 3')
    fireEvent.change(screen.getByLabelText('Filter by notebook'), {
      target: { value: JSON.stringify(another.provenance.source) },
    })
    await screen.findByText('1 / 1')
    expect(
      within(screen.getByLabelText('Filter by cell')).getByRole('option', {
        name: /Unavailable cell · b/,
      })
    ).toBeTruthy()
    expect(
      within(screen.getByLabelText('Filter by cell')).queryByRole('option', {
        name: /Unavailable cell · a/,
      })
    ).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter by notebook'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByLabelText('Filter by cell'), {
      target: {
        value: JSON.stringify([
          JSON.stringify(result.examples[0].provenance.source),
          'a',
        ]),
      },
    })
    await screen.findByText('1 / 2')
    fireEvent.click(screen.getByRole('button', { name: 'Next example' }))
    await screen.findByRole('heading', { name: 'Example 2 · Rejected' })
    expect(api.preview.mock.calls.at(-1)?.[0]).toEqual(result.examples[1])
  })
  it('does not display a stale diff under the next label', async () => {
    const { result, j } = fixture()
    let resolveFirst!: (value: ExamplePreview) => void
    api.preview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    render(<TrainingExamplesView docUri="local://file/test" store={store} />)
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Next example' }))
    await screen.findByRole('heading', { name: 'Example 2 · Rejected' })
    const wrongPreview = previewExample(j.operations, result.examples[0])
    wrongPreview.diff.cells[0].compareCell!.value = 'STALE RESPONSE'
    await act(async () => resolveFirst(wrongPreview))
    expect(screen.queryByText('STALE RESPONSE')).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Example 2 · Rejected' })
    ).toBeTruthy()
  })
  it('shows empty state, errors, warnings and allows explicit refresh', async () => {
    const { result } = fixture()
    api.load.mockResolvedValueOnce({ ...result, examples: [] })
    render(<TrainingExamplesView docUri="local://file/test" store={store} />)
    await screen.findByText(/No eligible examples yet/)
    expect(screen.getByRole('button', { name: 'Next example' })).toBeDisabled()
    api.load.mockRejectedValueOnce(new Error('OPFS quota exceeded'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh examples' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'OPFS quota exceeded'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh examples' }))
    await screen.findByRole('heading', { name: 'Example 1 · Accepted' })
    expect(screen.getByText(/extraction warning/)).toBeTruthy()
    expect(
      within(
        screen.getByRole('complementary', { name: 'Training examples' })
      ).getByText(/No sidecar is written/)
    ).toBeTruthy()
  })
})
