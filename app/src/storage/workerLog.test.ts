import { describe, expect, it } from 'vitest'

import { createLoggingRuntime } from '../lib/logging/runtime'
import { WorkerLogBuffer } from './workerLog'

describe('worker diagnostic log', () => {
  it('bounds retained events, exposes gaps, and pages filtered results without duplicates', () => {
    const runtime = createLoggingRuntime()
    const logs = new WorkerLogBuffer(runtime, { instanceId: 'one', epoch: 2 })
    for (let i = 0; i < 510; i++)
      runtime.log(i % 2 ? 'warn' : 'info', `event ${i}`)
    const first = logs.read({ limit: 2, minLevel: 'warn' })
    expect(first.events.map((e) => e.sequence)).toEqual([12, 14])
    expect(first).toMatchObject({
      dropped: 10,
      latestSequence: 510,
      hasMore: true,
    })
    const next = logs.read({
      afterSequence: first.nextSequence,
      limit: 2,
      minLevel: 'warn',
    })
    expect(next.events.map((e) => e.sequence)).toEqual([16, 18])
    expect(logs.read({ afterSequence: 508 })).toMatchObject({
      nextSequence: 510,
      hasMore: false,
    })
    logs.close()
  })

  it('isolates sinks/subscribers and excludes notebook payloads and credentials', () => {
    const runtime = createLoggingRuntime()
    runtime.subscribe(() => {
      throw new Error('bad subscriber')
    })
    const logs = new WorkerLogBuffer(
      runtime,
      { instanceId: 'one', epoch: 2 },
      () => {
        throw new Error('full disk')
      }
    )
    expect(() =>
      runtime.log(
        'warn',
        'Fetch https://host/path?access_token=private-token failed',
        {
          attrs: {
            scope: 'storage.owner',
            requestId: 'request-1',
            notebook: { cells: ['private notebook'] },
            accessToken: 'private-token',
            error: 'private error payload',
          },
        }
      )
    ).not.toThrow()
    const page = logs.read()
    expect(page.events[0]).toMatchObject({
      instanceId: 'one',
      sequence: 1,
      schemaVersion: 1,
      attrs: { scope: 'storage.owner', requestId: 'request-1' },
    })
    expect(JSON.stringify(page)).not.toMatch(
      /private-token|private notebook|private error payload/
    )
    page.events[0].attrs!.scope = 'modified'
    expect(logs.read().events[0].attrs!.scope).toBe('storage.owner')
    logs.close()
  })

  it('caps byte-sized responses and makes forward progress with large messages', () => {
    const runtime = createLoggingRuntime()
    const logs = new WorkerLogBuffer(runtime, { instanceId: 'one', epoch: 0 })
    for (let i = 0; i < 100; i++) runtime.log('info', '😀'.repeat(5000))
    const page = logs.read({ maxBytes: 16384 })
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.length).toBeLessThan(100)
    expect(page.hasMore).toBe(true)
    expect(
      logs.read({ afterSequence: page.nextSequence }).events[0].sequence
    ).toBe(page.nextSequence + 1)
    logs.close()
  })
})
