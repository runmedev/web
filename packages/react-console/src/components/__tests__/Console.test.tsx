import React from 'react'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../test/utils'
import Console from '../Console'

// Mock the renderers package to avoid web component initialization issues
vi.mock('@runmedev/renderers', () => ({
  ClientMessages: {},
  setContext: vi.fn(),
  default: {},
}))

vi.mock('../../streams', () => {
  const subscribers: any[] = []
  return {
    default: vi.fn().mockImplementation(() => ({
      connect: vi.fn(() => ({ subscribe: vi.fn() })),
      close: vi.fn(),
      stdout: { subscribe: vi.fn() },
      stderr: { subscribe: vi.fn() },
      exitCode: { subscribe: vi.fn() },
      pid: { subscribe: vi.fn() },
      mimeType: { subscribe: vi.fn() },
      sendExecuteRequest: vi.fn((req: any) => subscribers.push(req)),
      setCallback: vi.fn(),
    })),
    __subscribers: subscribers,
  }
})

describe('Console', () => {
  const defaultProps = {
    cellID: 'test-cell-1',
    runID: 'test-run-1',
    sequence: 1,
    commands: ['echo "Hello World"'],
    runner: {
      endpoint: 'ws://localhost:8080/ws',
      reconnect: true,
      interceptors: [],
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

  it('builds inline command ExecuteRequest for shellish languages', async () => {
    const { default: Streams, __subscribers } = (await import(
      '../../streams'
    )) as any
    render(
      <Console {...defaultProps} languageID="bash" commands={['echo hi']} />
    )
    // allow effect
    await Promise.resolve()
    expect((Streams as any).mock.calls.length).toBeGreaterThan(0)
    const sent = (__subscribers as any[]).pop()
    expect(sent?.config?.languageId).toBe('bash')
    expect(sent?.config?.mode).toBeDefined()
    // commands mode -> INLINE, source case commands
    expect(sent?.config?.source?.case).toBe('commands')
    expect(sent?.config?.source?.value?.items).toEqual(['echo hi'])
  })

  it('builds file ExecuteRequest for non-shell languages', async () => {
    const { __subscribers } = (await import('../../streams')) as any
    render(
      <Console
        {...defaultProps}
        languageID="python"
        commands={["print('hi')"]}
      />
    )
    await Promise.resolve()
    const sent = (__subscribers as any[]).pop()
    expect(sent?.config?.languageId).toBe('python')
    expect(sent?.config?.source?.case).toBe('script')
    expect(sent?.config?.mode).toBeDefined()
    expect(sent?.config?.fileExtension).toBe('python')
  })
})
