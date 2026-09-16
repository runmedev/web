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
}))
vi.mock('../../lib/trainingExamples/client', () => ({
  loadTrainingExamples: api.load,
  loadTrainingExamplePreview: api.preview,
}))
vi.mock('../../lib/notebookDataController', () => ({
  getNotebookDataController: () => ({
    getNotebookData: () => ({ flushPendingPersist: api.flush }),
  }),
}))
const store = {
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

beforeEach(() => vi.clearAllMocks())

describe('training examples viewer', () => {
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
        name: 'b',
      })
    ).toBeTruthy()
    expect(
      within(screen.getByLabelText('Filter by cell')).queryByRole('option', {
        name: 'a',
      })
    ).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter by notebook'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByLabelText('Filter by cell'), {
      target: { value: 'a' },
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
