import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  resume: vi.fn(),
  consoleFlush: vi.fn(),
  consoleResume: vi.fn(),
  model: {
    getSnapshot: () => ({ loaded: true, notebook: { cells: [] } }),
    getUri: () => 'local://file/a',
    hasActiveExecutions: () => false,
    isReviewPending: () => false,
    isReleasePending: () => false,
    isReadOnly: () => false,
    setReleasePending: vi.fn(),
    flushPendingPersist: vi.fn(),
  },
}))
vi.mock('../lib/notebookDataController', () => ({
  getNotebookDataController: () => ({
    getOpenNotebooks: () => [{ uri: 'local://file/a', state: 'loaded' }],
    getNotebookData: () => mocks.model,
  }),
}))
vi.mock('../lib/appConsole/appConsoleController', () => ({
  getAppConsoleData: () => ({
    flushForRelease: mocks.consoleFlush,
    resumeAfterFailedPreparation: mocks.consoleResume,
  }),
}))
vi.mock('../storage/tabRecoveryCheckpoint', () => ({
  checkpointEditorSessions: mocks.capture,
  checkpointEditorUris: () => new Set(['local://file/a']),
  resumeCheckpointTransport: mocks.resume,
}))
afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})
it('checkpoints replayable pending saves without flushing through the worker', async () => {
  mocks.capture.mockResolvedValue(new Set(['local://file/a']))
  const runtime = await import('./runtime')
  const release = runtime.registerUpgradeBlocker(
    () => 'Pending editor save',
    true,
    true
  )
  const { prepareTabReload } = await import('./prepareTabReload')
  await prepareTabReload()
  expect(mocks.capture).toHaveBeenCalledWith(
    new Map([['local://file/a', { cells: [] }]]),
    expect.any(AbortSignal)
  )
  expect(mocks.model.flushPendingPersist).not.toHaveBeenCalled()
  expect(mocks.model.setReleasePending).toHaveBeenLastCalledWith(true)
  release()
})
it('keeps editors usable if backup fails', async () => {
  mocks.capture.mockRejectedValue(new Error('quota'))
  const { prepareTabReload } = await import('./prepareTabReload')
  await expect(prepareTabReload()).rejects.toThrow('quota')
  expect(mocks.resume).toHaveBeenCalledOnce()
  expect(mocks.consoleResume).toHaveBeenCalledOnce()
  expect(mocks.model.setReleasePending).toHaveBeenLastCalledWith(false)
  const { assertReleaseWritable } = await import('./runtime')
  expect(assertReleaseWritable).not.toThrow()
})
it('unknown external effects block only this tab reload', async () => {
  const runtime = await import('./runtime')
  const release = runtime.registerUpgradeBlocker(
    () => 'Creation outcome unknown'
  )
  const { prepareTabReload } = await import('./prepareTabReload')
  await expect(prepareTabReload()).rejects.toThrow('Creation outcome unknown')
  expect(mocks.capture).not.toHaveBeenCalled()
  release()
})
it('refuses to discard an editor missing from the checkpoint', async () => {
  mocks.capture.mockResolvedValue(new Set())
  const { prepareTabReload } = await import('./prepareTabReload')
  await expect(prepareTabReload()).rejects.toThrow(
    'without replayable save recovery'
  )
  expect(mocks.model.setReleasePending).toHaveBeenLastCalledWith(false)
})

it('bounds a stalled console backup and leaves the tab editable', async () => {
  vi.useFakeTimers()
  mocks.consoleFlush.mockImplementationOnce(() => new Promise(() => {}))
  const { prepareTabReload } = await import('./prepareTabReload')
  const result = expect(prepareTabReload()).rejects.toThrow('backup timed out')
  await vi.advanceTimersByTimeAsync(15_000)
  await result
  expect(mocks.model.setReleasePending).toHaveBeenLastCalledWith(false)
  expect(mocks.capture).not.toHaveBeenCalled()
  vi.useRealTimers()
})
