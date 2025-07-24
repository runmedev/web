import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render, screen } from '../../../../test/utils'
import { SettingsProvider, useSettings } from '../SettingsContext'

// Mock dependencies
vi.mock('../../token', () => ({
  getSessionToken: vi.fn(),
}))

vi.mock('jwt-decode', () => ({
  jwtDecode: vi.fn(),
}))

vi.mock('@runmedev/react-console', () => ({
  Heartbeat: { INITIAL: 'initial' },
  StreamError: {},
  Streams: vi.fn().mockImplementation(() => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    connect: vi.fn(() => ({
      subscribe: vi.fn(),
    })),
    errors: {
      subscribe: vi.fn(),
    },
    heartbeat: {
      subscribe: vi.fn(),
    },
  })),
  genRunID: vi.fn(),
}))

// Test component to access context
const TestComponent = () => {
  const settings = useSettings()
  return (
    <div>
      <span data-testid="principal">{settings.principal}</span>
      <span data-testid="agent-endpoint">
        {settings.settings.agentEndpoint}
      </span>
      <span data-testid="require-auth">
        {settings.settings.requireAuth.toString()}
      </span>
    </div>
  )
}

describe('SettingsContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: {
        hostname: 'localhost',
        protocol: 'http:',
        port: '5173',
        origin: 'http://localhost:5173',
        href: 'http://localhost:5173',
      },
      writable: true,
    })
  })

  describe('SettingsProvider', () => {
    it('renders children without crashing', () => {
      render(
        <SettingsProvider>
          <div>Test Content</div>
        </SettingsProvider>
      )
      expect(screen.getByText('Test Content')).toBeInTheDocument()
    })

    it('provides default settings for development environment', async () => {
      const { getSessionToken } = await import('../../token')
      vi.mocked(getSessionToken).mockReturnValue('mock-token')

      const { jwtDecode } = await import('jwt-decode')
      vi.mocked(jwtDecode).mockReturnValue({ sub: 'test-user' })

      render(
        <SettingsProvider>
          <TestComponent />
        </SettingsProvider>
      )

      expect(screen.getByTestId('agent-endpoint')).toHaveTextContent(
        'http://localhost:8080'
      )
      expect(screen.getByTestId('require-auth')).toHaveTextContent('false')
    })

    it('handles unauthenticated user', async () => {
      const { getSessionToken } = await import('../../token')
      vi.mocked(getSessionToken).mockReturnValue(undefined)

      render(
        <SettingsProvider>
          <TestComponent />
        </SettingsProvider>
      )

      expect(screen.getByTestId('principal')).toHaveTextContent(
        'unauthenticated'
      )
    })

    it('handles token decoding errors', async () => {
      const { getSessionToken } = await import('../../token')
      vi.mocked(getSessionToken).mockReturnValue('invalid-token')

      const { jwtDecode } = await import('jwt-decode')
      vi.mocked(jwtDecode).mockImplementation(() => {
        throw new Error('Invalid token')
      })

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <SettingsProvider>
          <TestComponent />
        </SettingsProvider>
      )

      expect(screen.getByTestId('principal')).toHaveTextContent(
        'unauthenticated'
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        'Error decoding token',
        expect.any(Error)
      )

      consoleSpy.mockRestore()
    })

    it('uses provided requireAuth prop', async () => {
      const { getSessionToken } = await import('../../token')
      vi.mocked(getSessionToken).mockReturnValue('mock-token')

      const { jwtDecode } = await import('jwt-decode')
      vi.mocked(jwtDecode).mockReturnValue({ sub: 'test-user' })

      render(
        <SettingsProvider requireAuth={true}>
          <TestComponent />
        </SettingsProvider>
      )

      expect(screen.getByTestId('require-auth')).toHaveTextContent('true')
    })
  })

  describe('useSettings hook', () => {
    it('throws error when used outside provider', () => {
      const TestComponentWithoutProvider = () => {
        try {
          useSettings()
          return <div>No error</div>
        } catch (error) {
          return <div data-testid="error">{(error as Error).message}</div>
        }
      }

      render(<TestComponentWithoutProvider />)
      expect(screen.getByTestId('error')).toHaveTextContent(
        'useSettings must be used within a SettingsProvider'
      )
    })
  })
})
