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

const api = vi.hoisted(() => ({
  load: vi.fn(),
  preview: vi.fn(),
  flush: vi.fn(async () => {}),
}))
vi.mock('../../lib/trainingExamples/client', () => ({
  loadTrainingExamples: api.load,
  loadTrainingExamplePreview: api.preview,
  automaticExamplesEnabled: false,
  scheduleTrainingExamples: vi.fn(),
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
  const start = j.name('start')
  j.cell('a', 'improved')
  const end = j.name('end')
  j.decide(start, end, 'a', 'undo')
  const result: ExampleIndex = {
    ...extractExamples(j.operations, 'test'),
    sidecarPath: 'document.runme.examples',
    header: {
      record_type: 'runme.examples',
      format_version: 1,
      source: { notebookId: 'test', localUri: 'local://file/test' },
      ruleVersion: 'test',
      sourceChecksum: 'test',
    },
  }
  // Sort only this fixture so assertions exercise both labels independent of IDs.
  result.examples.sort((a, b) => Number(b.accepted) - Number(a.accepted))
  api.load.mockResolvedValue(result)
  api.preview.mockImplementation(async (_job, example) =>
    previewExample(j.operations, example)
  )
  return { result, j }
}

beforeEach(() => vi.clearAllMocks())

describe('training examples viewer', () => {
  it('navigates all examples with the corresponding label and real review cell diff', async () => {
    fixture()
    render(<TrainingExamplesView docUri="local://file/test" store={store} />)
    await screen.findByRole('heading', { name: 'Example 1 · Accepted' })
    expect(api.flush).toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Previous example' })
    ).toBeDisabled()
    const diff = screen.getByTestId('suggestion-modified-cell')
    expect(diff.querySelector('.line-through')?.textContent).toBeTruthy()
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
    wrongPreview.diff.cells[0].baseCell!.value = 'STALE RESPONSE'
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
      ).getByText(/Drive upload is not implemented/)
    ).toBeTruthy()
  })
})
