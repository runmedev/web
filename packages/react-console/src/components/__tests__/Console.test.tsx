import React from 'react'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../test/utils'
import Console from '../Console'

// Mock the streams module; likely required for disabled tests below
// vi.mock('../../streams', () => ({
//   default: vi.fn().mockImplementation(() => ({
//     connect: vi.fn(() => ({
//       subscribe: vi.fn(),
//     })),
//     subscribe: vi.fn(),
//     unsubscribe: vi.fn(),
//   })),
// }))

// Mock the renderers/client module
vi.mock('../../renderers/client', () => ({
  ClientMessages: {},
  setContext: vi.fn(),
}))

describe('Console', () => {
  const defaultProps = {
    cellID: 'test-cell-1',
    runID: 'test-run-1',
    sequence: 1,
    commands: ['echo "Hello World"'],
    runner: {
      endpoint: 'ws://localhost:8080/ws',
      reconnect: true,
      authorization: { bearerToken: 'test-token' },
    },
    settings: {
      rows: 20,
      fontSize: 12,
      fontFamily: 'monospace',
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders without crashing', () => {
    const { container } = render(<Console {...defaultProps} />)
    // The console should render a container element
    expect(container).toBeInTheDocument()
  })

  // TODO: fix these test cases
  //   it('applies custom className when provided', () => {
  //     const customClassName = 'custom-console-class'
  //     render(
  //       <Console
  //         {...defaultProps}
  //         settings={{ ...defaultProps.settings, className: customClassName }}
  //       />
  //     )

  //     const container = document.querySelector(`.${customClassName}`)
  //     expect(container).toBeInTheDocument()
  //   })

  //   it('creates streams with correct parameters', () => {
  //     const { default: Streams } = require('../../streams')

  //     render(<Console {...defaultProps} />)

  //     expect(Streams).toHaveBeenCalledWith({
  //       knownID: 'test-cell-1',
  //       runID: 'test-run-1',
  //       sequence: 1,
  //       options: {
  //         runnerEndpoint: 'ws://localhost:8080/ws',
  //         authorization: { type: 'none' },
  //         autoReconnect: true,
  //       },
  //     })
  //   })

  //   it('handles empty cellID gracefully', () => {
  //     const { default: Streams } = require('../../streams')

  //     render(<Console {...defaultProps} cellID="" />)

  //     // Should not create streams when cellID is empty
  //     expect(Streams).not.toHaveBeenCalled()
  //   })

  //   it('handles empty runID gracefully', () => {
  //     const { default: Streams } = require('../../streams')

  //     render(<Console {...defaultProps} runID="" />)

  //     // Should not create streams when runID is empty
  //     expect(Streams).not.toHaveBeenCalled()
  //   })

  //   it('handles empty runner endpoint gracefully', () => {
  //     const { default: Streams } = require('../../streams')

  //     render(
  //       <Console
  //         {...defaultProps}
  //         runner={{ ...defaultProps.runner, endpoint: '' }}
  //       />
  //     )

  //     // Should not create streams when endpoint is empty
  //     expect(Streams).not.toHaveBeenCalled()
  //   })

  //   it('calls onStdout callback when provided', () => {
  //     const onStdout = vi.fn()
  //     render(<Console {...defaultProps} onStdout={onStdout} />)

  //     // The callback should be available for the streams to use
  //     expect(onStdout).toBeDefined()
  //   })

  //   it('calls onStderr callback when provided', () => {
  //     const onStderr = vi.fn()
  //     render(<Console {...defaultProps} onStderr={onStderr} />)

  //     // The callback should be available for the streams to use
  //     expect(onStderr).toBeDefined()
  //   })

  //   it('calls onExitCode callback when provided', () => {
  //     const onExitCode = vi.fn()
  //     render(<Console {...defaultProps} onExitCode={onExitCode} />)

  //     // The callback should be available for the streams to use
  //     expect(onExitCode).toBeDefined()
  //   })
})
