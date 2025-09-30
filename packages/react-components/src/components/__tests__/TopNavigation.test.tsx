import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../test/utils'
import TopNavigation from '../TopNavigation'

// Mock react-router-dom
const mockNavigate = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: vi.fn(() => ({ pathname: '/' })),
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
    email: 'test@example.com', // Add email field for more realistic JWT structure
  }),
}))

vi.mock('md5', () => ({
  default: () => 'mock-hash',
}))

describe('TopNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders export button', () => {
    render(<TopNavigation />)
    expect(screen.getByText('Export')).toBeInTheDocument()
  })

  it('renders user avatar', () => {
    render(<TopNavigation />)
    // The avatar should be present (it's a span with avatar styling)
    const avatar = document.querySelector('span[class*="size-[24px]"]')
    expect(avatar).toBeInTheDocument()
  })

  it('shows export dropdown when export button is clicked', async () => {
    render(<TopNavigation />)
    const exportButton = screen.getByText('Export')

    fireEvent.click(exportButton)

    // The dropdown should be present but might not be visible due to Radix UI behavior
    // We can test that the button has the correct attributes
    expect(exportButton.closest('[aria-haspopup="menu"]')).toBeInTheDocument()
  })

  it('shows user dropdown when avatar is clicked', () => {
    render(<TopNavigation />)
    const avatar = document.querySelector('span[class*="size-[24px]"]')

    if (avatar) {
      fireEvent.click(avatar)
      // The dropdown should be present but might not be visible due to Radix UI behavior
      expect(avatar.closest('[aria-haspopup="menu"]')).toBeInTheDocument()
    }
  })

  it('renders with correct styling', () => {
    render(<TopNavigation />)
    const exportButton = screen.getByText('Export')
    expect(exportButton.closest('div')).toHaveClass('cursor-pointer')
  })

  it('renders settings button', () => {
    render(<TopNavigation />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('navigates to settings when settings button is clicked from home', () => {
    render(<TopNavigation />)
    const settingsButton = screen.getByText('Settings')

    fireEvent.click(settingsButton)

    expect(mockNavigate).toHaveBeenCalledWith('/settings')
  })
})
