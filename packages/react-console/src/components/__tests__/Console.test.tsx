import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../test/utils'
import Console, { ConsoleProps } from '../Console'

// Mock the renderers package to avoid web component initialization issues
vi.mock('@runmedev/renderers', () => ({
  ClientMessages: {},
  setContext: vi.fn(),
  default: {},
}))

describe('Console', () => {
  const defaultProps: ConsoleProps = {
    cellID: 'test-cell-1',
    runID: 'test-run-1',
    sequence: 1,
    commands: ['echo "Hello World"'],
    runner: {
      endpoint: 'ws://localhost:8080/ws',
      reconnect: true,
      interceptors: [],
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

  it('sets correct attributes on web component for shell languages', () => {
    const { container } = render(
      <Console {...defaultProps} languageID="bash" commands={['echo hi']} />
    )

    // Find the runme-console web component
    const webComponent = container.querySelector('runme-console')
    expect(webComponent).toBeInTheDocument()

    // Verify the web component has the correct attributes
    expect(webComponent?.getAttribute('id')).toBe('test-cell-1')
    expect(webComponent?.getAttribute('takeFocus')).toBe('true')
    expect(webComponent?.getAttribute('initialRows')).toBe('20')
    expect(webComponent?.getAttribute('initialContent')).toBe('')

    // Verify the stream attribute contains the execution config
    const streamAttr = webComponent?.getAttribute('stream')
    expect(streamAttr).toBeTruthy()
    const streamConfig = JSON.parse(streamAttr!)
    expect(streamConfig.knownID).toBe('test-cell-1')
    expect(streamConfig.runID).toBe('test-run-1')
    expect(streamConfig.sequence).toBe(1)
    expect(streamConfig.languageID).toBe('bash')
    expect(streamConfig.runnerEndpoint).toBe('ws://localhost:8080/ws')
    expect(streamConfig.reconnect).toBe(true)

    // Verify commands are set as a property (not attribute)
    expect((webComponent as any)?.commands).toEqual(['echo hi'])
  })

  it('sets correct attributes on web component for non-shell languages', () => {
    const { container } = render(
      <Console
        {...defaultProps}
        languageID="python"
        commands={["print('hi')"]}
      />
    )

    // Find the runme-console web component
    const webComponent = container.querySelector('runme-console')
    expect(webComponent).toBeInTheDocument()

    // Verify the web component has the correct attributes
    expect(webComponent?.getAttribute('id')).toBe('test-cell-1')
    expect(webComponent?.getAttribute('takeFocus')).toBe('true')
    expect(webComponent?.getAttribute('initialRows')).toBe('20')
    expect(webComponent?.getAttribute('initialContent')).toBe('')

    // Verify the stream attribute contains the execution config
    const streamAttr = webComponent?.getAttribute('stream')
    expect(streamAttr).toBeTruthy()
    const streamConfig = JSON.parse(streamAttr!)
    expect(streamConfig.knownID).toBe('test-cell-1')
    expect(streamConfig.runID).toBe('test-run-1')
    expect(streamConfig.sequence).toBe(1)
    expect(streamConfig.languageID).toBe('python')
    expect(streamConfig.runnerEndpoint).toBe('ws://localhost:8080/ws')
    expect(streamConfig.reconnect).toBe(true)

    // Verify commands are set as a property (not attribute)
    expect((webComponent as any)?.commands).toEqual(["print('hi')"])
  })
})
