// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSKernel } from '../../lib/runtime/jsKernel'
import EnvironmentPanel from './EnvironmentPanel'

/** Exercise the same form interactions used to configure notebook variables. */
function addVariable(name: string, value: string) {
  fireEvent.change(screen.getByLabelText('Variable name'), {
    target: { value: name },
  })
  fireEvent.change(screen.getByLabelText('Variable value'), {
    target: { value },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add variable' }))
}

describe('EnvironmentPanel', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('persists variables for browser JS, edits and deletes them without changing app settings', async () => {
    localStorage.setItem('runme.sidePanel.active', 'environment')
    localStorage.setItem('auth-token', 'private-token')
    const view = render(<EnvironmentPanel />)
    addVariable('OPENAI_PROJECT_ID', 'proj_example')
    addVariable('OPENAI_ORG_ID', 'org_example')

    // The actual browser kernel resolves localStorage from the host global.
    const result = await new JSKernel().run(`return {
      'OpenAI-Project': localStorage.getItem('runme.env.OPENAI_PROJECT_ID'),
      'OpenAI-Organization': localStorage.getItem('runme.env.OPENAI_ORG_ID'),
    }`)
    expect(result).toEqual({
      exitCode: 0,
      result: {
        'OpenAI-Project': 'proj_example',
        'OpenAI-Organization': 'org_example',
      },
    })
    view.unmount()
    render(<EnvironmentPanel />)
    const table = screen.getByRole('table')
    expect(within(table).getByText('proj_example')).toBeTruthy()
    expect(within(table).queryByText('private-token')).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit OPENAI_PROJECT_ID' })
    )
    fireEvent.change(screen.getByLabelText('Variable value'), {
      target: { value: 'proj_updated' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(localStorage.getItem('runme.env.OPENAI_PROJECT_ID')).toBe(
      'proj_updated'
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete OPENAI_PROJECT_ID' })
    )
    expect(localStorage.getItem('runme.env.OPENAI_PROJECT_ID')).toBeNull()
    expect(localStorage.getItem('runme.env.OPENAI_ORG_ID')).toBe('org_example')
    expect(localStorage.getItem('auth-token')).toBe('private-token')
    expect(localStorage.getItem('runme.sidePanel.active')).toBe('environment')
  })

  it('rejects duplicate and invalid names, preserves strings exactly, and cancels edits', () => {
    render(<EnvironmentPanel />)
    addVariable('CUSTOM_VALUE', '  spaced value  ')
    addVariable('CUSTOM_VALUE', 'replacement')
    expect(screen.getByRole('alert').textContent).toContain('already exists')
    expect(localStorage.getItem('runme.env.CUSTOM_VALUE')).toBe(
      '  spaced value  '
    )
    addVariable('invalid.name', 'value')
    expect(screen.getByRole('alert').textContent).toContain('Use letters')
    expect(localStorage.getItem('runme.env.invalid.name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit CUSTOM_VALUE' }))
    fireEvent.change(screen.getByLabelText('Variable value'), {
      target: { value: 'unsaved' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(localStorage.getItem('runme.env.CUSTOM_VALUE')).toBe(
      '  spaced value  '
    )
    addVariable('EMPTY', '')
    expect(localStorage.getItem('runme.env.EMPTY')).toBe('')
  })

  it('refreshes external changes without discarding an unsaved draft', () => {
    render(<EnvironmentPanel />)
    fireEvent.change(screen.getByLabelText('Variable name'), {
      target: { value: 'DRAFT' },
    })
    localStorage.setItem('runme.env.FROM_JS', 'browser value')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh variables' }))
    expect(
      within(screen.getByRole('table')).getByText('browser value')
    ).toBeTruthy()
    localStorage.setItem('runme.env.FROM_TAB', 'other tab')
    fireEvent(
      window,
      new StorageEvent('storage', { key: 'runme.env.FROM_TAB' })
    )
    expect(
      within(screen.getByRole('table')).getByText('other tab')
    ).toBeTruthy()
    expect(
      (screen.getByLabelText('Variable name') as HTMLInputElement).value
    ).toBe('DRAFT')
    localStorage.clear()
    fireEvent(window, new StorageEvent('storage', { key: null }))
    expect(screen.getByText(/No variables yet/)).toBeTruthy()
  })

  it('reports failed writes and retains input for retry', () => {
    render(<EnvironmentPanel />)
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Full', 'QuotaExceededError')
      })
    addVariable('OPENAI_PROJECT_ID', 'proj_retry')
    expect(screen.getByRole('alert').textContent).toContain('Could not save')
    expect(
      (screen.getByLabelText('Variable value') as HTMLInputElement).value
    ).toBe('proj_retry')
    expect(screen.getByRole('status').textContent).toBe('')
    write.mockRestore()
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    expect(localStorage.getItem('runme.env.OPENAI_PROJECT_ID')).toBe(
      'proj_retry'
    )
  })

  it('reports unavailable storage and failed deletes without claiming success', () => {
    localStorage.setItem('runme.env.KEEP', 'value')
    render(<EnvironmentPanel />)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete KEEP' }))
    expect(screen.getByRole('alert').textContent).toContain('Could not delete')
    expect(localStorage.getItem('runme.env.KEEP')).toBe('value')
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh variables' }))
    expect(screen.getByRole('alert').textContent).toContain('Could not read')
  })
})
