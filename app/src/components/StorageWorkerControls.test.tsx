import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { STORAGE_WORKER_CONTROL } from '../storage/storageWorkerControl'
import { ReleaseControls } from './ReleaseControls'

afterEach(() => {
  cleanup()
  delete window.runmeVersions
})

it('keeps targeted worker controls available when settings fail and a worker is draining', async () => {
  window.runmeVersions = {
    get: vi.fn(async () => {
      throw new Error('Release settings read timeout (get)')
    }),
  } as unknown as NonNullable<Window['runmeVersions']>
  const peer = new BroadcastChannel(STORAGE_WORKER_CONTROL)
  const commands: unknown[] = []
  peer.onmessage = ({ data }) => {
    commands.push(data)
    if (data.type === 'discover')
      for (const instanceId of ['worker-one', 'worker-two'])
        peer.postMessage({
          type: 'status',
          status: {
            instanceId,
            epoch: 1,
            phase: 'draining',
            phaseElapsedMs: 5000,
            uptimeMs: 10000,
          },
        })
  }
  try {
    render(<ReleaseControls />)
    expect(await screen.findByText('Instance: worker-two')).toBeTruthy()
    expect(
      await screen.findByText(/Release settings read timeout/)
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Pin Release' })
    ).toBeTruthy()
    const row = screen.getByText('Instance: worker-two').closest('div')!
    const force = within(row).getByRole('button', { name: 'Force stop worker' })
    expect(force.hasAttribute('disabled')).toBe(false)
    fireEvent.click(force)
    await waitFor(() =>
      expect(commands).toContainEqual({
        type: 'stop',
        instanceId: 'worker-two',
        force: true,
        restart: false,
      })
    )
    expect(commands).not.toContainEqual(
      expect.objectContaining({ type: 'stop', instanceId: 'worker-one' })
    )
    expect(screen.getByText(/No reply means unknown/)).toBeTruthy()
  } finally {
    peer.close()
  }
})
