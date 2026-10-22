import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  EXPLORER_SYNC_INTERVAL_MS,
  ExplorerSyncController,
  syncExplorerFolder,
} from './explorerSync'

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ExplorerSyncController', () => {
  it('polls fresh folder targets and stops polling when disconnected', async () => {
    vi.useFakeTimers()
    const controller = new ExplorerSyncController()
    let folders = ['one']
    const refresh = vi.fn(async () => {})
    const stop = controller.connect({ folders: () => folders, refresh })
    cleanup.push(stop)
    await vi.advanceTimersByTimeAsync(EXPLORER_SYNC_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledWith('one')
    folders = ['two']
    await vi.advanceTimersByTimeAsync(EXPLORER_SYNC_INTERVAL_MS)
    expect(refresh).toHaveBeenLastCalledWith('two')
    stop()
    await vi.advanceTimersByTimeAsync(EXPLORER_SYNC_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('skips hidden/offline ticks and catches up when connectivity returns', async () => {
    vi.useFakeTimers()
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const refresh = vi.fn(async () => {})
    cleanup.push(
      new ExplorerSyncController().connect({ folders: () => ['one'], refresh })
    )
    await vi.advanceTimersByTimeAsync(EXPLORER_SYNC_INTERVAL_MS)
    visibility.mockReturnValue('visible')
    online.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(EXPLORER_SYNC_INTERVAL_MS)
    expect(refresh).not.toHaveBeenCalled()
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('coalesces clicks and timer ticks, isolates failures and reports busy state', async () => {
    vi.useFakeTimers()
    const controller = new ExplorerSyncController()
    let finish!: () => void
    const deferred = new Promise<void>((resolve) => {
      finish = resolve
    })
    const refresh = vi.fn(async (uri: string) => {
      if (uri === 'one') await deferred
      if (uri === 'bad') throw new Error('Expired credentials')
    })
    cleanup.push(
      controller.connect({
        folders: () => ['one', 'one', 'bad', 'three'],
        refresh,
      })
    )
    const first = controller.sync()
    expect(controller.getSnapshot()).toBe(true)
    expect(controller.sync()).toBe(first)
    await vi.advanceTimersByTimeAsync(EXPLORER_SYNC_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    finish()
    expect(await first).toEqual({
      refreshed: ['one', 'three'],
      failed: ['bad'],
    })
    expect(controller.getSnapshot()).toBe(false)
  })

  it('does not refresh folders removed or disconnected during a pass', async () => {
    const controller = new ExplorerSyncController()
    let folders = ['one', 'two']
    const refresh = vi.fn(async () => {
      folders = ['one']
    })
    const stop = controller.connect({ folders: () => folders, refresh })
    cleanup.push(stop)
    expect(await controller.sync()).toEqual({ refreshed: ['one'], failed: [] })
    expect(refresh).toHaveBeenCalledOnce()
    stop()
    await expect(controller.sync()).rejects.toThrow('not ready')
  })

  it('uses shallow mirror sync and live filesystem listings without syncing notebook payloads', async () => {
    const store = { sync: vi.fn(async () => {}) }
    const refreshView = vi.fn(async () => {})
    await syncExplorerFolder('local://folder/drive', store, refreshView)
    expect(store.sync).toHaveBeenCalledWith('local://folder/drive', {
      recursive: false,
    })
    await syncExplorerFolder('fs://workspace/', store, refreshView)
    expect(store.sync).toHaveBeenCalledOnce()
    expect(refreshView).toHaveBeenCalledTimes(2)
    await expect(
      syncExplorerFolder('local://file/notebook', store, refreshView)
    ).rejects.toThrow('folder URI')
  })
})
