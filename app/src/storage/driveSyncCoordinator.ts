export interface DriveSyncCoordinator {
  runExclusive<T>(localUri: string, operation: () => Promise<T>): Promise<T>
}

const DRIVE_SYNC_LOCK_PREFIX = 'runme:drive-sync:'
const fallbackTails = new Map<string, Promise<void>>()

function hasWebLocks(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function'
  )
}

async function runInProcessExclusive<T>(
  lockName: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fallbackTails.get(lockName) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  fallbackTails.set(lockName, tail)

  await previous
  try {
    return await operation()
  } finally {
    release()
    if (fallbackTails.get(lockName) === tail) {
      fallbackTails.delete(lockName)
    }
  }
}

/**
 * Coordinates Drive work for one local notebook across same-origin tabs and
 * workers. Web Locks are authoritative in browsers. The in-process fallback
 * keeps tests and non-browser callers serialized without pretending to provide
 * cross-tab safety where the Web Locks API is unavailable.
 */
export const browserDriveSyncCoordinator: DriveSyncCoordinator = {
  async runExclusive<T>(
    localUri: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const lockName = `${DRIVE_SYNC_LOCK_PREFIX}${localUri}`
    if (!hasWebLocks()) {
      return runInProcessExclusive(lockName, operation)
    }
    return navigator.locks.request(lockName, operation)
  },
}
