import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReleaseControls } from './ReleaseControls'
import { ReleaseRecoveryControls } from './ReleaseRecoveryControls'
import { showWorkspaceDocument } from '../lib/workspaceDocuments/workspaceDocumentController'
import type { Control, Manifest } from '../releases/control'

vi.mock('../lib/workspaceDocuments/workspaceDocumentController', () => ({
  showWorkspaceDocument: vi.fn(),
}))
const installed = `${'a'.repeat(40)}-${'b'.repeat(64)}`
const id = `${'c'.repeat(40)}-${'d'.repeat(64)}`
function setup(
  get = async () =>
    ({ active: { manifest: { releaseId: installed } } }) as Control
) {
  const api = {
    get,
    check: vi.fn(async () => {}),
    pin: vi.fn(async () => {}),
    upgrade: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    prune: vi.fn(),
    prepareRecovery: vi.fn(async () => ({ releaseId: id }) as Manifest),
    recover: vi.fn(async () => {}),
  }
  window.runmeVersions = api
  return api
}
afterEach(() => {
  cleanup()
  delete window.runmeVersions
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
async function selectCommit(value = id) {
  fireEvent.click(
    screen.getByRole('button', { name: /Choose another release/ })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Enter a commit' }))
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Commit SHA or release ID' }),
    { target: { value } }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
  await screen.findByRole('heading', { name: 'Pin this release?' })
}

it.each(['failed', 'pending', 'missing'])(
  'keeps Pin Release reachable when settings are %s',
  async (mode) => {
    if (mode !== 'missing')
      setup(
        mode === 'failed'
          ? async () => {
              throw new Error('read timeout (get)')
            }
          : () => new Promise<Control>(() => {})
      )
    render(<ReleaseControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Pin Release' }))
    expect(showWorkspaceDocument).toHaveBeenCalledWith('app://pin-release')
    expect(screen.queryByText('Recovery and rollback')).toBeNull()
    if (mode === 'failed') await screen.findByText(/read timeout/)
  }
)
it('pins the installed release only after review without downloading or activating', async () => {
  const api = setup()
  render(<ReleaseRecoveryControls />)
  const current = screen.getByRole('button', {
    name: /Keep the installed release/,
  })
  await waitFor(() => expect(current.hasAttribute('disabled')).toBe(false))
  fireEvent.click(current)
  expect(api.pin).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Pin installed release' }))
  await screen.findByRole('heading', { name: 'Release pinned' })
  expect(api.pin).toHaveBeenCalledOnce()
  expect(api.check).not.toHaveBeenCalled()
  expect(api.recover).not.toHaveBeenCalled()
})
it('reviews an exact build, pins it, and activates only on a separate action', async () => {
  const api = setup()
  render(<ReleaseRecoveryControls />)
  await selectCommit()
  expect(api.check).not.toHaveBeenCalled()
  expect(api.prepareRecovery).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Pin and download' }))
  await screen.findByRole('heading', { name: 'Release pinned' })
  expect(api.check).toHaveBeenCalledWith({ kind: 'pinned', releaseId: id })
  expect(api.recover).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: 'Activate release and update this tab' })
  )
  await waitFor(() =>
    expect(api.recover).toHaveBeenCalledWith({ kind: 'pinned', releaseId: id })
  )
})
it('browses published builds and reviews the exact selection without pinning yet', async () => {
  const api = setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ format: 1, releases: [{ releaseId: id }] })
        )
    )
  )
  render(<ReleaseRecoveryControls />)
  fireEvent.click(
    screen.getByRole('button', { name: /Choose another release/ })
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'Load published releases' })
  )
  fireEvent.click(
    await screen.findByRole('button', { name: /Commit cccccccc/ })
  )
  expect(
    screen.getByRole('heading', { name: 'Pin this release?' })
  ).toBeTruthy()
  expect(screen.getByText('d'.repeat(64))).toBeTruthy()
  expect(api.check).not.toHaveBeenCalled()
})
it('reports ambiguous commits without guessing a build', async () => {
  const api = setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: 1,
            releases: [
              { releaseId: id },
              { releaseId: `${'c'.repeat(40)}-${'e'.repeat(64)}` },
            ],
          })
        )
    )
  )
  render(<ReleaseRecoveryControls />)
  fireEvent.click(
    screen.getByRole('button', { name: /Choose another release/ })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Enter a commit' }))
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'ccccccc' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Multiple builds'
  )
  expect(api.check).not.toHaveBeenCalled()
})
it('retains a verified recovery download when settings cannot record the pin', async () => {
  const api = setup(async () => {
    throw new Error('read timeout (get)')
  })
  api.check.mockRejectedValue(new Error('read timeout (get)'))
  render(<ReleaseRecoveryControls />)
  await selectCommit()
  fireEvent.click(screen.getByRole('button', { name: 'Pin and download' }))
  await screen.findByRole('alert')
  expect(api.prepareRecovery).toHaveBeenCalledWith({
    kind: 'pinned',
    releaseId: id,
  })
  expect(api.recover).not.toHaveBeenCalled()
  expect(screen.queryByRole('heading', { name: 'Release pinned' })).toBeNull()
  fireEvent.click(
    screen.getByRole('button', { name: 'Recover with this release' })
  )
  await waitFor(() =>
    expect(api.recover).toHaveBeenCalledWith({ kind: 'pinned', releaseId: id })
  )
})
it('keeps recovery navigation and diagnostics available during a hung download', async () => {
  const api = setup(() => new Promise<Control>(() => {}))
  api.prepareRecovery.mockImplementation(() => new Promise<Manifest>(() => {}))
  render(<ReleaseRecoveryControls />)
  await selectCommit()
  fireEvent.click(screen.getByRole('button', { name: 'Pin and download' }))
  fireEvent.click(screen.getByText('Troubleshooting'))
  expect(
    screen
      .getByRole('link', { name: /Open recovery in another tab/ })
      .getAttribute('href')
  ).toContain(`release=${id}`)
  fireEvent.click(
    screen.getByRole('button', { name: 'Show release settings diagnostics' })
  )
  expect(screen.getByLabelText('Release settings diagnostics')).toBeTruthy()
})
