import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  models: [] as ReturnType<typeof model>[],
  consoleFlush: vi.fn(),
  close: vi.fn(),
}))
vi.mock('../lib/notebookDataController', () => ({
  getNotebookDataController: () => ({
    getOpenNotebooks: () => mocks.models.map((_, i) => ({ uri: String(i) })),
    getNotebookData: (uri: string) => mocks.models[Number(uri)],
  }),
}))
vi.mock('../lib/appConsole/appConsoleController', () => ({
  getAppConsoleData: () => ({
    getSnapshot: () => ({ cells: [] }),
    resumeAfterFailedPreparation: vi.fn(),
    flushForRelease: mocks.consoleFlush,
  }),
}))
vi.mock('./databases', () => ({ closeReleaseDatabases: mocks.close }))
afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  mocks.close.mockClear()
  mocks.consoleFlush.mockReset()
})
function model() {
  return {
    getSnapshot: () => ({ loaded: true, uri: 'local://file/test' }),
    hasActiveExecutions: () => false,
    isReviewPending: () => false,
    isReleasePending: () => false,
    setReleasePending: vi.fn(),
    isReadOnly: () => false,
    flushPendingPersist: vi.fn(async () => {}),
    getObservedOperationHeads: () => ['durable-operation'],
  }
}
it('requires durable acknowledgements without using sessionStorage', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  const m = model()
  mocks.models = [m]
  const { prepareRelease } = await import('./prepare')
  expect(await prepareRelease()).toEqual([
    { uri: 'local://file/test', heads: ['durable-operation'] },
  ])
  expect(m.flushPendingPersist).toHaveBeenCalledOnce()
  expect(mocks.consoleFlush).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalledOnce()
})
it('a failed or uncertain save blocks handoff and preserves the editor', async () => {
  const m = model()
  mocks.models = [m]
  m.flushPendingPersist.mockRejectedValue(new Error('commit uncertain'))
  const { prepareRelease } = await import('./prepare')
  await expect(prepareRelease()).rejects.toThrow('commit uncertain')
  expect(mocks.close).not.toHaveBeenCalled()
  expect(m.setReleasePending).toHaveBeenLastCalledWith(false)
})
it('waits for delayed saves before closing readers', async () => {
  const m = model()
  mocks.models = [m]
  let finish!: () => void
  m.flushPendingPersist.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { prepareRelease } = await import('./prepare')
  const ready = prepareRelease()
  expect(mocks.close).not.toHaveBeenCalled()
  finish()
  await ready
  expect(mocks.close).toHaveBeenCalledOnce()
})
