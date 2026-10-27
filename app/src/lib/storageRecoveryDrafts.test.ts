import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import {
  backupNotebookRecoveryDrafts,
  captureNotebookRecoveryDrafts,
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

it('backs up without flushing and abort does not unlock a later recovery round', async () => {
  const m = model()
  m.flushPendingPersist.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const releaseOld = await prepareNotebookStorageRestart(controller.signal)
  expect(readRecoveryDrafts()).toHaveLength(1)
  expect(m.flushPendingPersist).not.toHaveBeenCalled()
  controller.abort()
  expect(m.setReleasePending).toHaveBeenLastCalledWith(false)
  const releaseNew = await prepareNotebookStorageRestart()
  expect(m.setReleasePending).toHaveBeenLastCalledWith(true)
  const calls = m.setReleasePending.mock.calls.length
  releaseOld()
  expect(m.setReleasePending).toHaveBeenCalledTimes(calls)
  releaseNew()
  expect(m.setReleasePending).toHaveBeenLastCalledWith(false)
})

it.each(['[null]', '[{"uri":"local://file/a"}]', '{}'])(
  'rejects malformed recovery metadata without clearing its bytes: %s',
  (raw) => {
    sessionStorage.setItem('runme/storage-recovery-drafts/v1', raw)
    expect(() => readRecoveryDrafts()).toThrow('malformed')
    expect(sessionStorage.getItem('runme/storage-recovery-drafts/v1')).toBe(raw)
  }
)

it('backs up every notebook independently of a hung first save', async () => {
  const first = model()
  const second = model()
  second.getSnapshot = () => ({
    ...first.getSnapshot(),
    uri: 'local://second',
    name: 'second.runme',
  })
  mocks.getOpenNotebooks.mockReturnValue([
    { uri: 'local://first' },
    { uri: 'local://second' },
  ])
  mocks.getNotebookData.mockImplementation((uri) =>
    uri === 'local://first' ? first : second
  )
  first.flushPendingPersist.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const release = await prepareNotebookStorageRestart(controller.signal)
  expect(first.flushPendingPersist).not.toHaveBeenCalled()
  expect(readRecoveryDrafts().map((draft) => draft.name)).toEqual([
    'draft.runme',
    'second.runme',
  ])
  controller.abort()
  release()
  expect(second.setReleasePending).toHaveBeenLastCalledWith(false)
})

it('captures fresh editor copies without touching unavailable session storage or persistence', () => {
  const m = model()
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('unavailable')
  })
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  const copies = captureNotebookRecoveryDrafts()
  expect(JSON.parse(copies[0].content).cells[0].value).toBe('unsaved edit')
  expect(get).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
  expect(m.flushPendingPersist).not.toHaveBeenCalled()
  expect(m.setReleasePending).not.toHaveBeenCalled()
})

it('backs up before worker coordination without flushing or locking editors', () => {
  const m = model()
  expect(backupNotebookRecoveryDrafts()).toBe(1)
  expect(readRecoveryDrafts()).toHaveLength(1)
  expect(m.flushPendingPersist).not.toHaveBeenCalled()
  expect(m.setReleasePending).not.toHaveBeenCalled()
})

it('keeps earlier bytes on quota failure and still captures the latest editor for download', () => {
  const m = model()
  backupNotebookRecoveryDrafts()
  const before = sessionStorage.getItem('runme/storage-recovery-drafts/v1')
  m.getSnapshot().notebook.cells[0].value = 'latest unsaved edit'
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError')
  })
  expect(() => backupNotebookRecoveryDrafts()).toThrow('QuotaExceededError')
  expect(sessionStorage.getItem('runme/storage-recovery-drafts/v1')).toBe(
    before
  )
  const copies = captureNotebookRecoveryDrafts()
  expect(JSON.parse(copies[0].content).cells[0].value).toBe(
    'latest unsaved edit'
  )
})
