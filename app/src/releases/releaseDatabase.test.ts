import { afterEach, expect, it, vi } from 'vitest'

import { control, readControl } from './control'
import { ReleaseControlError, releaseTransaction } from './releaseDatabase'

/** Drive browser events explicitly to exercise errors and callbacks that arrive
 * after cancellation, which an always-successful IndexedDB mock would miss.
 */
function database(value?: unknown) {
  const get: any = { result: value }
  const table = { get: vi.fn(() => get), put: vi.fn(() => ({}) as any) }
  const tx: any = { objectStore: () => table, abort: vi.fn() }
  const db: any = {
    transaction: vi.fn(() => tx),
    close: vi.fn(),
    createObjectStore: vi.fn(),
  }
  const open: any = { result: db, transaction: tx }
  const factory = { open: vi.fn(() => open) }
  vi.stubGlobal('indexedDB', factory)
  return { open, db, tx, get, table, factory }
}
async function opened(mock: ReturnType<typeof database>) {
  mock.open.onsuccess()
  await Promise.resolve()
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('uses stable defaults only when the settings record is missing', async () => {
  const mock = database()
  const pending = readControl()
  mock.open.onupgradeneeded()
  await opened(mock)
  mock.get.onsuccess()
  mock.tx.oncomplete()
  await expect(pending).resolves.toEqual({
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    tabs: {},
  })
  expect(mock.db.createObjectStore).toHaveBeenCalledWith('state')
  expect(mock.table.put).not.toHaveBeenCalled()
  expect(mock.db.close).toHaveBeenCalledOnce()
})

it.each(['blocked', 'error'])(
  'rejects an open %s and closes a connection that arrives later',
  async (event) => {
    const mock = database()
    const pending = readControl()
    const failed = expect(pending).rejects.toBeInstanceOf(ReleaseControlError)
    mock.open['on' + event]()
    await failed
    mock.open.onupgradeneeded()
    mock.open.onsuccess()
    expect(mock.tx.abort).toHaveBeenCalledTimes(2)
    expect(mock.db.createObjectStore).not.toHaveBeenCalled()
    expect(mock.db.transaction).not.toHaveBeenCalled()
    expect(mock.db.close).toHaveBeenCalledOnce()
  }
)

it('times out a silent open, permits a fresh attempt and closes the late result', async () => {
  vi.useFakeTimers()
  const mock = database()
  const failed = expect(readControl()).rejects.toMatchObject({
    stage: 'open',
    reason: 'timeout',
  })
  await vi.advanceTimersByTimeAsync(5000)
  await failed
  mock.open.onsuccess()
  expect(mock.db.close).toHaveBeenCalledOnce()
  expect(mock.db.transaction).not.toHaveBeenCalled()
  const retry = database()
  const pending = readControl()
  await opened(retry)
  retry.get.onsuccess()
  retry.tx.oncomplete()
  await expect(pending).resolves.toMatchObject({
    selection: { name: 'stable' },
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts a stalled read and never executes late mutations', async () => {
  vi.useFakeTimers()
  const mock = database()
  const mutate = vi.fn()
  const failed = expect(control(mutate)).rejects.toMatchObject({
    stage: 'read',
    reason: 'timeout',
  })
  await opened(mock)
  await vi.advanceTimersByTimeAsync(5000)
  await failed
  mock.get.onsuccess()
  mock.tx.oncomplete()
  expect(mutate).not.toHaveBeenCalled()
  expect(mock.table.put).not.toHaveBeenCalled()
  expect(mock.tx.abort).toHaveBeenCalledOnce()
  expect(mock.db.close).toHaveBeenCalledOnce()
})

it('waits for commit, aborting a stalled write instead of reporting success', async () => {
  vi.useFakeTimers()
  const mock = database()
  const failed = expect(
    control((s) => {
      s.healthy = 'test'
    })
  ).rejects.toMatchObject({ stage: 'commit', reason: 'timeout' })
  await opened(mock)
  mock.get.onsuccess()
  expect(mock.table.put).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5000)
  await failed
  expect(mock.tx.abort).toHaveBeenCalledOnce()
  expect(mock.db.close).toHaveBeenCalledOnce()
})

it.each(['request', 'abort', 'transaction'])(
  'reports a %s failure without treating it as missing settings',
  async (event) => {
    const mock = database()
    const mutate = vi.fn()
    const failed = expect(control(mutate)).rejects.toBeInstanceOf(
      ReleaseControlError
    )
    await opened(mock)
    if (event === 'request') mock.get.onerror()
    else if (event === 'abort') mock.tx.onabort()
    else mock.tx.onerror()
    await failed
    expect(mutate).not.toHaveBeenCalled()
    expect(mock.table.put).not.toHaveBeenCalled()
    expect(mock.db.close).toHaveBeenCalledOnce()
  }
)

it('preserves coordination rejection rather than classifying it as storage failure', async () => {
  const mock = database()
  const failure = new Error('Upgrade pending')
  const failed = expect(
    control(() => {
      throw failure
    })
  ).rejects.toBe(failure)
  await opened(mock)
  mock.get.onsuccess()
  await failed
  expect(mock.tx.abort).toHaveBeenCalledOnce()
  expect(mock.table.put).not.toHaveBeenCalled()
})

it('closes connections on version changes and successful commit', async () => {
  const mock = database({ value: 'original' })
  const pending = releaseTransaction('test', true, (value) => ({
    state: value,
    result: 'done',
  }))
  await opened(mock)
  mock.db.onversionchange()
  mock.get.onsuccess()
  mock.tx.oncomplete()
  await expect(pending).resolves.toBe('done')
  expect(mock.db.close).toHaveBeenCalledTimes(2)
})

it('rejects synchronous browser errors and clears its deadline', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('Unavailable')
    },
  })
  await expect(readControl()).rejects.toMatchObject({
    stage: 'open',
    reason: 'failed',
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts an upgrade that began before the open deadline expired', async () => {
  vi.useFakeTimers()
  const mock = database()
  const failed = expect(readControl()).rejects.toMatchObject({
    stage: 'open',
    reason: 'timeout',
  })
  mock.open.onupgradeneeded()
  await vi.advanceTimersByTimeAsync(5000)
  await failed
  expect(mock.tx.abort).toHaveBeenCalledOnce()
  mock.open.onsuccess()
  expect(mock.db.close).toHaveBeenCalledOnce()
  expect(mock.db.transaction).not.toHaveBeenCalled()
})

it('preserves unsupported records rather than replacing them with defaults', async () => {
  const mock = database({ format: 2, active: { epoch: 9 } })
  const failed = expect(readControl()).rejects.toThrow(
    'Unsupported release-control format'
  )
  await opened(mock)
  mock.get.onsuccess()
  await failed
  expect(mock.table.put).not.toHaveBeenCalled()
  expect(mock.db.close).toHaveBeenCalledOnce()
})

it('reports a missing store or transaction creation error and closes the connection', async () => {
  const mock = database()
  mock.db.transaction.mockImplementation(() => {
    throw new Error('Missing store')
  })
  const failed = expect(readControl()).rejects.toMatchObject({
    stage: 'read',
    reason: 'failed',
  })
  await opened(mock)
  await failed
  expect(mock.db.close).toHaveBeenCalledOnce()
})

it.each(['open', 'transaction', 'get', 'put'] as const)(
  'retains the browser error and identifies the %s operation',
  async (operation) => {
    const mock = database()
    const cause = new DOMException('private record contents', 'NotFoundError')
    const failed = expect(control(() => 'ok')).rejects.toMatchObject({
      cause,
      operation,
      diagnosticDetails: { operation, browserError: 'NotFoundError' },
    })
    if (operation === 'open') {
      mock.open.error = cause
      mock.open.onerror()
    } else {
      if (operation === 'transaction')
        mock.db.transaction.mockImplementation(() => {
          throw cause
        })
      await opened(mock)
      if (operation === 'get') {
        mock.get.error = cause
        mock.get.onerror()
      } else if (operation === 'put') {
        mock.table.put.mockImplementation(() => {
          throw cause
        })
        mock.get.onsuccess()
      }
    }
    await failed
  }
)

it('reports a delayed put error without losing it to the transaction abort', async () => {
  const mock = database()
  const cause = new DOMException('disk full', 'QuotaExceededError')
  const put = { error: cause } as IDBRequest<IDBValidKey>
  mock.table.put.mockReturnValue(put)
  const failed = expect(control(() => 'ok')).rejects.toMatchObject({
    operation: 'put',
    cause,
    reason: 'failed',
  })
  await opened(mock)
  mock.get.onsuccess()
  put.onerror!.call(put, new Event('error'))
  mock.tx.onabort()
  await failed
})

it('keeps exception text and arbitrary names out of visible diagnostics', () => {
  const cause = new DOMException('private record contents', 'NotFoundError')
  const error = new ReleaseControlError('read', 'failed', 'transaction', cause)
  expect(error.message).toContain('transaction: NotFoundError')
  expect(JSON.stringify(error.diagnosticDetails)).not.toContain('private')
  const arbitrary = new ReleaseControlError(
    'read',
    'failed',
    'get',
    new DOMException('secret', 'secret')
  )
  expect(arbitrary.message).not.toContain('secret')
  expect(arbitrary.diagnosticDetails).not.toHaveProperty('browserError')
})

it.each(['get', 'chunks', 'commit'] as const)(
  'identifies the last callback reached when %s stalls',
  async (phase) => {
    vi.useFakeTimers()
    const mock = database(
      phase === 'chunks'
        ? { encoding: 'runme-control-json-chunks-v1', count: 2 }
        : undefined
    )
    const chunks: any[] = []
    if (phase === 'chunks')
      mock.table.get.mockImplementation((key?: string) => {
        if (key === 'control') return mock.get
        const request = { result: '{}' }
        chunks.push(request)
        return request
      })
    const pending = readControl()
    const failed = expect(pending).rejects.toMatchObject({
      diagnosticDetails: {
        trace: {
          mode: 'readonly',
          phase:
            phase === 'get'
              ? 'get-requested'
              : phase === 'chunks'
                ? 'reading-chunks'
                : 'waiting-for-commit',
          ...(phase === 'chunks' ? { chunksRead: 1, chunksTotal: 2 } : {}),
        },
      },
    })
    await opened(mock)
    if (phase !== 'get') mock.get.onsuccess()
    if (phase === 'chunks') chunks[0].onsuccess()
    await vi.advanceTimersByTimeAsync(5000)
    await failed
    expect(mock.tx.abort).toHaveBeenCalledOnce()
  }
)

it('offers memory-only pending diagnostics and keeps stored values out of traces', async () => {
  const { releaseDatabaseDiagnostics } = await import('./releaseDiagnostics')
  const mock = database({ format: 1, private: 'secret notebook contents' })
  const pending = readControl()
  await opened(mock)
  const before = mock.factory.open.mock.calls.length
  expect(releaseDatabaseDiagnostics().active).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: 'get-requested' }),
    ])
  )
  expect(mock.factory.open).toHaveBeenCalledTimes(before)
  mock.get.onsuccess()
  mock.tx.oncomplete()
  await pending
  expect(releaseDatabaseDiagnostics().activeCount).toBe(0)
  expect(JSON.stringify(releaseDatabaseDiagnostics())).not.toContain(
    'secret notebook contents'
  )
})
