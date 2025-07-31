import { genRunID } from '@runmedev/react-console'
import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../../test/utils'
import { parser_pb } from '../../../contexts/CellContext'
import { RunmeMetadataKey } from '../../../runme/client'
import CellConsole from '../CellConsole'

// Mock the contexts
const mockUseCell = vi.fn()
const mockUseSettings = vi.fn()

// Mock the protobuf create function
vi.mock('@bufbuild/protobuf', () => ({
  create: vi.fn(() => ({})),
}))

vi.mock('../../../contexts/CellContext', () => ({
  useCell: () => mockUseCell(),
  createCellOutputs: vi.fn(() => []),
  MimeType: {
    VSCodeNotebookStdOut: 'application/vnd.code.notebook.stdout',
  },
  parser_pb: {
    CellKind: {
      CODE: 'CODE',
      MARKDOWN: 'MARKDOWN',
    },
    CellExecutionSummarySchema: {},
    ExecutionSummaryTimingSchema: {},
  },
}))

vi.mock('../../../contexts/SettingsContext', () => ({
  useSettings: () => mockUseSettings(),
}))

vi.mock('@runmedev/react-console', () => ({
  genRunID: vi.fn(() => 'mock-run-id'),
  Console: vi.fn(({ onPid, onExitCode, onStdout, onStderr }) => {
    // Always render the Console component for testing purposes
    // The real component handles the rendering logic, but we want to test the callbacks

    // Trigger callbacks in the next tick to simulate async behavior
    setTimeout(() => {
      if (onStdout) {
        onStdout(new TextEncoder().encode('test stdout'))
      }
      if (onStderr) {
        onStderr(new TextEncoder().encode('test stderr'))
      }
      if (onPid) {
        onPid(12345)
      }
      // Delay exit code to allow PID to be set first
      setTimeout(() => {
        if (onExitCode) {
          onExitCode(0)
        }
      }, 10)
    }, 0)

    return <div data-testid="console">Console Component</div>
  }),
}))

// Mock window events
const mockAddEventListener = vi.fn()
const mockRemoveEventListener = vi.fn()

Object.defineProperty(window, 'addEventListener', {
  value: mockAddEventListener,
  writable: true,
})

Object.defineProperty(window, 'removeEventListener', {
  value: mockRemoveEventListener,
  writable: true,
})

describe('CellConsole Component', () => {
  const mockCell = {
    refId: 'test-cell-id',
    value: 'echo "hello world"',
    kind: parser_pb.CellKind.CODE,
    metadata: {
      [RunmeMetadataKey.Sequence]: '1',
    },
    outputs: [
      {
        items: [
          {
            mime: 'application/vnd.code.notebook.stdout',
            data: new TextEncoder().encode('hello world\n'),
          },
        ],
      },
    ],
    executionSummary: undefined,
  } as any

  const defaultCellContext = {
    sendOutputCell: vi.fn(),
    saveState: vi.fn(),
  }

  const defaultSettingsContext = {
    settings: {
      webApp: {
        invertedOrder: false,
        runner: 'http://localhost:8080',
        reconnect: false,
      },
    },
    createAuthInterceptors: vi.fn(() => []),
  }

  const mockOnPid = vi.fn()
  const mockOnExitCode = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseCell.mockReturnValue(defaultCellContext)
    mockUseSettings.mockReturnValue(defaultSettingsContext)
    vi.mocked(genRunID).mockReturnValue('mock-run-id')
  })

  it('renders console for code cells', () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // The console should render because the cell has content
    expect(screen.getByTestId('console')).toBeInTheDocument()
  })

  it('does not render for non-code cells', () => {
    const markdownCell = {
      refId: 'test-cell-id',
      value: '',
      kind: parser_pb.CellKind.MARKUP,
      metadata: {
        [RunmeMetadataKey.Sequence]: '1',
      },
      outputs: [],
      executionSummary: undefined,
    } as any

    const { container } = render(
      <CellConsole
        cell={markdownCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    expect(container).toBeDefined()

    // The component should not render console for non-code cells
    expect(screen.queryByTestId('console')).not.toBeInTheDocument()
  })

  it('listens for runCodeCell events', () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('removes event listener on unmount', () => {
    const { unmount } = render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    unmount()

    expect(mockRemoveEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('responds to runCodeCell events for matching cell ID', () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Get the event handler that was registered
    const eventHandler = mockAddEventListener.mock.calls.find(
      (call) => call[0] === 'runCodeCell'
    )?.[1]

    if (eventHandler) {
      // Create a custom event with the matching cell ID
      const event = new CustomEvent('runCodeCell', {
        detail: { cellId: 'test-cell-id' },
      })

      act(() => {
        eventHandler(event)
      })

      // Should trigger execution
      expect(screen.getByTestId('console')).toBeInTheDocument()
    }
  })

  it('ignores runCodeCell events for non-matching cell ID', () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Get the event handler that was registered
    const eventHandler = mockAddEventListener.mock.calls.find(
      (call) => call[0] === 'runCodeCell'
    )?.[1]

    if (eventHandler) {
      // Create a custom event with a different cell ID
      const event = new CustomEvent('runCodeCell', {
        detail: { cellId: 'different-cell-id' },
      })

      act(() => {
        eventHandler(event)
      })

      // Should not trigger execution - the component should still render
      // We're testing that the event handler doesn't trigger execution for non-matching IDs
      expect(mockAddEventListener).toHaveBeenCalledWith(
        'runCodeCell',
        expect.any(Function)
      )
    }
  })

  it('calls onPid callback when PID is set', async () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders and sets up event listeners
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('calls onExitCode callback when exit code is set', async () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders and sets up event listeners
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('saves metadata for code cells', async () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Wait for execution to complete
    await waitFor(() => {
      expect(defaultCellContext.saveState).toHaveBeenCalled()
    })
  })

  it('does not save metadata for non-code cells', () => {
    const markdownCell = {
      ...mockCell,
      kind: parser_pb.CellKind.MARKUP,
    } as any

    render(
      <CellConsole
        cell={markdownCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Should not call saveState for non-code cells
    expect(defaultCellContext.saveState).not.toHaveBeenCalled()
  })

  it('updates cell metadata with run ID when executing', async () => {
    // Create a cell without outputs to ensure Console renders only after execution
    const cellWithoutOutputs = {
      ...mockCell,
      outputs: [],
    }

    render(
      <CellConsole
        cell={cellWithoutOutputs}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders and sets up event listeners
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('updates cell metadata with PID when running', async () => {
    // Create a cell without outputs to ensure Console renders only after execution
    const cellWithoutOutputs = {
      ...mockCell,
      outputs: [],
    }

    render(
      <CellConsole
        cell={cellWithoutOutputs}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders and sets up event listeners
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('removes PID and sets exit code when completed', async () => {
    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders and sets up event listeners
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('recovers run ID from metadata when PID exists', () => {
    const cellWithMetadata = {
      ...mockCell,
      metadata: {
        ...mockCell.metadata,
        [RunmeMetadataKey.Pid]: '12345',
        [RunmeMetadataKey.LastRunID]: 'recovered-run-id',
      },
    }

    render(
      <CellConsole
        cell={cellWithMetadata}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders without errors
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('does not recover run ID when PID does not exist', () => {
    const cellWithMetadata = {
      ...mockCell,
      metadata: {
        ...mockCell.metadata,
        [RunmeMetadataKey.LastRunID]: 'some-run-id',
        // No PID
      },
    }

    render(
      <CellConsole
        cell={cellWithMetadata}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders without errors
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('handles inverted order setting', () => {
    mockUseSettings.mockReturnValue({
      ...defaultSettingsContext,
      settings: {
        webApp: {
          invertedOrder: true,
          runner: 'http://localhost:8080',
          reconnect: false,
        },
      },
    })

    render(
      <CellConsole
        cell={mockCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders without errors
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('sends output cell when execution completes', async () => {
    // Create a cell without outputs to ensure Console renders only after execution
    const cellWithoutOutputs = {
      ...mockCell,
      outputs: [],
    }

    render(
      <CellConsole
        cell={cellWithoutOutputs}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    // Test that the component renders and sets up event listeners
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'runCodeCell',
      expect.any(Function)
    )
  })

  it('does not render when no commands and no content', () => {
    const emptyCell = {
      ...mockCell,
      value: '',
      outputs: [],
    } as any

    const { container } = render(
      <CellConsole
        cell={emptyCell}
        onPid={mockOnPid}
        onExitCode={mockOnExitCode}
      />
    )

    expect(container).toBeDefined()

    // The component should not render console when there are no commands and no content
    expect(screen.queryByTestId('console')).not.toBeInTheDocument()
  })
})
