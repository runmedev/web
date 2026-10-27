import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReleaseControls } from './ReleaseControls'
import type { Control, Manifest } from '../releases/control'
const id = `${'a'.repeat(40)}-${'b'.repeat(64)}`
afterEach(() => {
  cleanup()
  delete window.runmeVersions
  vi.unstubAllGlobals()
})
/** A failed or forever-pending installed-state read must not gate rescue actions. */
it.each(['failed', 'pending', 'missing'])(
  'keeps recovery reachable when settings are %s',
  async (mode) => {
    const prepareRecovery = vi.fn(async () => ({ releaseId: id }) as Manifest)
    const recover = vi.fn(async () => {})
    if (mode !== 'missing')
      window.runmeVersions = {
        get:
          mode === 'failed'
            ? () => Promise.reject(new Error('read timeout (get)'))
            : () => new Promise<Control>(() => {}),
        check: vi.fn(),
        upgrade: vi.fn(),
        retry: vi.fn(),
        cancel: vi.fn(),
        prune: vi.fn(),
        prepareRecovery,
        recover,
      }
    render(<ReleaseControls />)
    expect(
      screen
        .getByRole('link', { name: 'Open recovery in another tab' })
        .getAttribute('target')
    ).toBe('_blank')
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Commit SHA or release ID' }),
      { target: { value: id } }
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare selected release' })
    )
    if (mode === 'missing') {
      await screen.findByText(/This launcher requires/)
      expect(prepareRecovery).not.toHaveBeenCalled()
    } else {
      await screen.findByText(/downloaded and verified/)
      expect(prepareRecovery).toHaveBeenCalledWith({
        kind: 'pinned',
        releaseId: id,
      })
      expect(recover).not.toHaveBeenCalled()
      fireEvent.click(
        screen.getByRole('button', { name: 'Activate selected release' })
      )
      await waitFor(() =>
        expect(recover).toHaveBeenCalledWith({ kind: 'pinned', releaseId: id })
      )
    }
    expect(
      screen
        .getByRole('link', { name: 'Open recovery in another tab' })
        .getAttribute('href')
    ).toContain(`release=${id}`)
  }
)
it('keeps recovery navigation available during a hung download', async () => {
  window.runmeVersions = {
    get: () => new Promise<Control>(() => {}),
    check: vi.fn(),
    upgrade: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    prune: vi.fn(),
    prepareRecovery: () => new Promise<Manifest>(() => {}),
  }
  render(<ReleaseControls />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: id } })
  fireEvent.click(
    screen.getByRole('button', { name: 'Prepare selected release' })
  )
  await waitFor(() =>
    expect(
      screen
        .getByRole('link', { name: 'Open recovery in another tab' })
        .getAttribute('href')
    ).toContain(id)
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'Show release settings diagnostics' })
  )
  expect(screen.getByLabelText('Release settings diagnostics')).toBeTruthy()
})
