// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { WorkspaceProvider, useWorkspace } from './WorkspaceContext'

vi.mock('../lib/runtime/AppState', () => ({
  appState: { setWorkspaceHandlers: vi.fn() },
}))

/** Model Explorer's automatic default-root addition after provider startup. */
function WorkspaceProbe() {
  const { state, addItem, persistenceError } = useWorkspace()
  return <>
    <output>{JSON.stringify(state.items)}</output>
    {persistenceError && <p role="alert">{persistenceError}</p>}
    <button onClick={() => addItem('local://folder/local')}>Add default</button>
  </>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

it.each(['{broken', '{"items":false}', '{"items":[null]}'])(
  'preserves unreadable workspace bytes even after default root creation: %s',
  (raw) => {
    localStorage.setItem('runme/workspace', raw)
    render(<WorkspaceProvider><WorkspaceProbe /></WorkspaceProvider>)
    fireEvent.click(screen.getByText('Add default'))
    expect(localStorage.getItem('runme/workspace')).toBe(raw)
    expect(screen.getByRole('alert').textContent).toContain('will not be saved')
  }
)

it('does not overwrite a workspace after a transient read failure; reload restores it', () => {
  const raw = JSON.stringify({ items: ['local://folder/preserved'] })
  localStorage.setItem('runme/workspace', raw)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
    throw new DOMException('Unavailable', 'SecurityError')
  })
  const view = render(<WorkspaceProvider><WorkspaceProbe /></WorkspaceProvider>)
  fireEvent.click(screen.getByText('Add default'))
  expect(localStorage.getItem('runme/workspace')).toBe(raw)
  view.unmount()
  render(<WorkspaceProvider><WorkspaceProbe /></WorkspaceProvider>)
  expect(screen.getByRole('status').textContent).toContain('local://folder/preserved')
})

it('migrates healthy legacy entries and persists explicit additions', () => {
  localStorage.setItem('aisre/workspace', JSON.stringify({
    items: [{ uri: 'local://folder/preserved' }],
  }))
  render(<WorkspaceProvider><WorkspaceProbe /></WorkspaceProvider>)
  fireEvent.click(screen.getByText('Add default'))
  expect(JSON.parse(localStorage.getItem('runme/workspace')!)).toEqual({
    items: ['local://folder/preserved', 'local://folder/local'],
  })
  expect(localStorage.getItem('aisre/workspace')).toBeNull()
})
