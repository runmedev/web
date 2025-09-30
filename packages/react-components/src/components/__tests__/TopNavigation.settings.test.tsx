import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../test/utils'
import TopNavigation from '../TopNavigation'

// Mock react-router-dom
const mockNavigate = vi.fn()
let currentPathname = '/'

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: currentPathname }),
  }
})

// Mock the contexts and modules
vi.mock('../../contexts/CellContext', () => ({
  useCell: () => ({
    resetSession: vi.fn(),
    exportDocument: vi.fn(),
  }),
}))

vi.mock('../../token', () => ({
  getSessionToken: () => 'mock-token',
}))

vi.mock('jwt-decode', () => ({
  jwtDecode: () => ({
    sub: 'test@example.com',
    email: 'test@example.com',
  }),
}))

vi.mock('md5', () => ({
  default: () => 'mock-hash',
}))

describe('TopNavigation Settings Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentPathname = '/'
  })

  it('navigates to settings when settings button is clicked from home', () => {
    currentPathname = '/'

    render(<TopNavigation />)
    const settingsButton = screen.getByText('Settings')

    fireEvent.click(settingsButton)

    expect(mockNavigate).toHaveBeenCalledWith('/settings')
  })

  it('navigates to home when settings button is clicked from settings page', () => {
    currentPathname = '/settings'

    render(<TopNavigation />)
    const settingsButton = screen.getByText('Settings')

    fireEvent.click(settingsButton)

    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('navigates to settings when on any other page', () => {
    currentPathname = '/some-other-page'

    render(<TopNavigation />)
    const settingsButton = screen.getByText('Settings')

    fireEvent.click(settingsButton)

    expect(mockNavigate).toHaveBeenCalledWith('/settings')
  })
})
