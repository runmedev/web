import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import {
  prepareNotebookStorageRestart,
  readRecoveryDrafts,
} from './storageRecoveryDrafts'

const mocks = vi.hoisted(() => ({
  getOpenNotebooks: vi.fn(),
  getNotebookData: vi.fn(),
}))
vi.mock('./notebookDataController', () => ({
  getNotebookDataController: () => mocks,
}))
afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})
function model() {
  const notebook = create(parser_pb.NotebookSchema, {
    cells: [
      { refId: 'draft', value: 'unsaved edit', kind: 2, languageId: 'python' },
    ],
  })
  const m = {
    getSnapshot: () => ({
      uri: 'local://file/draft',
      name: 'draft.runme',
      loaded: true,
      notebook,
    }),
    isReadOnly: () => false,
    hasActiveExecutions: () => false,
    isReleasePending: () => false,
    isReviewPending: () => false,
    setReleasePending: vi.fn(),
    flushPendingPersist: vi.fn(async () => {}),
  }
  mocks.getOpenNotebooks.mockReturnValue([{ uri: 'local://file/draft' }])
  mocks.getNotebookData.mockReturnValue(m)
  return m
}
describe('restart editor preservation', () => {
  it('keeps a reload-safe copy when the version mismatch rejects normal saving', async () => {
    const m = model()
    m.flushPendingPersist.mockRejectedValue(
      new Error('Storage worker version mismatch')
    )
    const release = await prepareNotebookStorageRestart()
    expect(JSON.parse(readRecoveryDrafts()[0].content).cells[0].value).toBe(
      'unsaved edit'
    )
    expect(m.setReleasePending).toHaveBeenLastCalledWith(true)
    release()
    expect(m.setReleasePending).toHaveBeenLastCalledWith(false)
  })
  it('does not discard earlier recovery copies', async () => {
    const m = model()
    const release = await prepareNotebookStorageRestart()
    release()
    m.getSnapshot().notebook.cells[0].value = 'another edit'
    ;(await prepareNotebookStorageRestart())()
    expect(readRecoveryDrafts()).toHaveLength(2)
  })
  it('blocks restart and unlocks editors if recovery storage is full', async () => {
    const m = model()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await expect(prepareNotebookStorageRestart()).rejects.toThrow(
      'Could not preserve'
    )
    expect(m.setReleasePending).toHaveBeenLastCalledWith(false)
  })
  it('does not interrupt running notebook work', async () => {
    const m = model()
    m.hasActiveExecutions = () => true
    await expect(prepareNotebookStorageRestart()).rejects.toThrow(
      'Stop running cells'
    )
    expect(m.setReleasePending).not.toHaveBeenCalled()
  })
})

it('also blocks restart for running cells in read-only notebooks', async () => {
  const m = model()
  m.isReadOnly = () => true
  m.hasActiveExecutions = () => true
  await expect(prepareNotebookStorageRestart()).rejects.toThrow(
    'Stop running cells'
  )
  expect(m.setReleasePending).not.toHaveBeenCalled()
})
