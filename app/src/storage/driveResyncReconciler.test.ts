// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DRIVE_RECONCILE_INTERVAL_MS,
  startDriveResyncReconciler,
} from './driveResyncReconciler'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Drive level reconciliation lifecycle', () => {
  it('scans on startup, periodically, and online without another edit; cleanup stops work', async () => {
    vi.useFakeTimers()
    const reconcileDriveBackedFiles = vi.fn().mockResolvedValue([])
    stop = startDriveResyncReconciler({ reconcileDriveBackedFiles })
    expect(reconcileDriveBackedFiles).toHaveBeenCalledWith(
      expect.objectContaining({ retryErrors: false })
    )
    await vi.advanceTimersByTimeAsync(DRIVE_RECONCILE_INTERVAL_MS)
    expect(reconcileDriveBackedFiles).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(reconcileDriveBackedFiles).toHaveBeenCalledTimes(3)
    const { shouldContinue } = reconcileDriveBackedFiles.mock.calls[2][0]
    stop()
    expect(shouldContinue()).toBe(false)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(2 * DRIVE_RECONCILE_INTERVAL_MS)
    expect(reconcileDriveBackedFiles).toHaveBeenCalledTimes(3)
  })

  it('allows an observed auth recovery to bypass backoff once', async () => {
    vi.useFakeTimers()
    const reconcileDriveBackedFiles = vi.fn().mockResolvedValue([])
    stop = startDriveResyncReconciler(
      { reconcileDriveBackedFiles },
      { retryErrors: true }
    )
    expect(reconcileDriveBackedFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryErrors: true })
    )
    await vi.advanceTimersByTimeAsync(DRIVE_RECONCILE_INTERVAL_MS)
    expect(reconcileDriveBackedFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryErrors: false })
    )
  })

  it('waits for connectivity and retries a failed scan on the next tick', async () => {
    vi.useFakeTimers()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const reconcileDriveBackedFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error('DB unavailable'))
      .mockResolvedValue([])
    stop = startDriveResyncReconciler({ reconcileDriveBackedFiles })
    await vi.advanceTimersByTimeAsync(DRIVE_RECONCILE_INTERVAL_MS)
    expect(reconcileDriveBackedFiles).not.toHaveBeenCalled()
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(DRIVE_RECONCILE_INTERVAL_MS)
    expect(reconcileDriveBackedFiles).toHaveBeenCalledTimes(2)
  })

  it('coalesces wake-ups during a slow pass instead of running overlapping scans', async () => {
    vi.useFakeTimers()
    let complete!: (value: string[]) => void
    const reconcileDriveBackedFiles = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            complete = resolve
          })
      )
      .mockResolvedValue([])
    stop = startDriveResyncReconciler({ reconcileDriveBackedFiles })
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(3 * DRIVE_RECONCILE_INTERVAL_MS)
    expect(reconcileDriveBackedFiles).toHaveBeenCalledTimes(1)
    complete([])
    await vi.advanceTimersByTimeAsync(0)
    expect(reconcileDriveBackedFiles).toHaveBeenCalledTimes(2)
  })
})
