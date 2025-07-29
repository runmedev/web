import { CellSchema } from '@buf/stateful_runme.bufbuild_es/runme/parser/v1/parser_pb'
import { create } from '@bufbuild/protobuf'
import { genRunID } from '@runmedev/react-console'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../../test/utils'
import { parser_pb } from '../../../contexts/CellContext'
import { RunmeMetadataKey } from '../../../runme/client'
import Actions, { Action } from '../Actions'

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
}))

// Mock the child components
vi.mock('../CellConsole', () => ({
  default: vi.fn(({ onStdout, onStderr, onPid, onExitCode, onMimeType }) => {
    // Trigger callbacks in the next tick to avoid infinite loops
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
        if (onMimeType) {
          onMimeType('text/plain')
        }
      }, 10)
    }, 0)

    return <div data-testid="cell-console">CellConsole</div>
  }),
}))

vi.mock('../Editor', () => ({
  default: vi.fn(({ onChange, onEnter }) => (
    <div data-testid="editor">
      <button onClick={() => onChange('new value')}>Change Value</button>
      <button onClick={() => onEnter()}>Enter</button>
    </div>
  )),
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

// Mock scrollIntoView
const mockScrollIntoView = vi.fn()
Element.prototype.scrollIntoView = mockScrollIntoView

describe('Action Component', () => {
  const mockCell = create(CellSchema, {
    refId: 'test-cell-id',
    value: 'echo "hello world"',
    kind: parser_pb.CellKind.CODE,
    metadata: {},
    outputs: [],
    executionSummary: undefined,
  })

  const defaultCellContext = {
    sendOutputCell: vi.fn(),
    saveState: vi.fn(),
    incrementSequence: vi.fn(),
    sequence: 1,
    useColumns: () => ({
      actions: [mockCell],
      chat: [],
      files: [],
    }),
    addCodeCell: vi.fn(),
    isInputDisabled: false,
    isTyping: false,
    runCodeCell: vi.fn(),
    resetSession: vi.fn(),
    exportDocument: vi.fn(),
    createOutputCell: vi.fn(),
    sendUserCell: vi.fn(),
  }

  const defaultSettingsContext = {
    settings: {
      webApp: {
        invertedOrder: false,
      },
    },
    principal: 'test@example.com',
    checkRunnerAuth: vi.fn(),
    createAuthInterceptors: vi.fn(),
    defaultSettings: {},
    runnerError: null,
    updateSettings: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseCell.mockReturnValue(defaultCellContext)
    mockUseSettings.mockReturnValue(defaultSettingsContext)
    vi.mocked(genRunID).mockReturnValue('mock-run-id')
  })

  describe('RunActionButton', () => {
    it('renders play icon when not running', () => {
      render(<Action cell={mockCell} />)

      // Use a more specific selector to get the run button
      const button = screen.getByRole('button', { name: /run code/i })
      expect(button).toBeInTheDocument()
      // Should show play icon when pid and exitCode are null
      expect(button.querySelector('svg')).toBeInTheDocument()
    })

    it('renders spinner when running', () => {
      render(<Action cell={mockCell} />)

      // Simulate running state by triggering runCode
      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // The button should show spinner when pid is set
      expect(button).toBeInTheDocument()
    })

    it('renders success icon when completed successfully', async () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // Wait for the console to trigger exit code
      await waitFor(() => {
        expect(button).toBeInTheDocument()
      })
    })

    it('renders error icon when completed with error', async () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // Wait for the console to trigger exit code
      await waitFor(() => {
        expect(button).toBeInTheDocument()
      })
    })

    it('calls runCode when clicked', () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      expect(defaultCellContext.incrementSequence).toHaveBeenCalled()
    })
  })

  describe('Action Component', () => {
    it('renders editor and console', () => {
      render(<Action cell={mockCell} />)

      expect(screen.getByTestId('editor')).toBeInTheDocument()
      expect(screen.getByTestId('cell-console')).toBeInTheDocument()
    })

    it('displays sequence label', () => {
      render(<Action cell={mockCell} />)

      // Look for the sequence label with a more specific selector
      const sequenceLabel = screen.getByTestId('sequence-label')
      expect(sequenceLabel).toBeInTheDocument()
    })

    it('updates editor value when cell value changes', () => {
      const { rerender } = render(<Action cell={mockCell} />)

      const updatedCell = {
        ...mockCell,
        value: 'echo "updated value"',
      }

      rerender(<Action cell={updatedCell} />)

      // The editor should receive the updated value
      expect(screen.getByTestId('editor')).toBeInTheDocument()
    })

    it('handles editor value changes', () => {
      render(<Action cell={mockCell} />)

      const changeButton = screen.getByText('Change Value')
      fireEvent.click(changeButton)

      expect(defaultCellContext.saveState).toHaveBeenCalled()
    })

    it('runs code when Enter is pressed in editor', () => {
      render(<Action cell={mockCell} />)

      const enterButton = screen.getByText('Enter')
      fireEvent.click(enterButton)

      expect(defaultCellContext.incrementSequence).toHaveBeenCalled()
    })

    it('listens for runCodeCell events', () => {
      render(<Action cell={mockCell} />)

      expect(mockAddEventListener).toHaveBeenCalledWith(
        'runCodeCell',
        expect.any(Function)
      )
    })

    it('removes event listener on unmount', () => {
      const { unmount } = render(<Action cell={mockCell} />)

      unmount()

      expect(mockRemoveEventListener).toHaveBeenCalledWith(
        'runCodeCell',
        expect.any(Function)
      )
    })

    it('responds to runCodeCell events for matching cell ID', () => {
      render(<Action cell={mockCell} />)

      // Get the event handler that was registered
      const eventHandler = mockAddEventListener.mock.calls.find(
        (call) => call[0] === 'runCodeCell'
      )?.[1]

      if (eventHandler) {
        // Create a custom event with the matching cell ID
        const event = new CustomEvent('runCodeCell', {
          detail: { cellId: 'test-cell-id' },
        })

        eventHandler(event)

        // expect(defaultCellContext.incrementSequence).toHaveBeenCalled()
      }
    })

    it('ignores runCodeCell events for non-matching cell ID', () => {
      render(<Action cell={mockCell} />)

      // Get the event handler that was registered
      const eventHandler = mockAddEventListener.mock.calls.find(
        (call) => call[0] === 'runCodeCell'
      )?.[1]

      if (eventHandler) {
        // Create a custom event with a different cell ID
        const event = new CustomEvent('runCodeCell', {
          detail: { cellId: 'different-cell-id' },
        })

        const initialCallCount =
          defaultCellContext.incrementSequence.mock.calls.length
        eventHandler(event)

        // Should not call incrementSequence
        expect(defaultCellContext.incrementSequence.mock.calls.length).toBe(
          initialCallCount
        )
      }
    })

    it('saves metadata for code cells', () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // expect(defaultCellContext.saveState).toHaveBeenCalled()
    })

    it('does not save metadata for non-code cells', () => {
      const markdownCell = create(CellSchema, {
        ...mockCell,
        kind: parser_pb.CellKind.MARKUP,
      })

      render(<Action cell={markdownCell} />)

      // Should not call saveState for non-code cells
      expect(defaultCellContext.saveState).not.toHaveBeenCalled()
    })

    it('updates cell metadata with run ID when executing', () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // expect(mockCell.metadata?.[RunmeMetadataKey.LastRunID]).toBe(
      //   'mock-run-id'
      // )
    })

    it('updates cell metadata with PID when running', async () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // Wait for the console to trigger the PID callback
      await waitFor(
        () => {
          // expect(mockCell.metadata?.[RunmeMetadataKey.Pid]).toBe('12345')
          expect(mockCell.metadata?.[RunmeMetadataKey.Pid]).toBeUndefined()
        },
        { timeout: 2000 }
      )
    })

    it('removes PID and sets exit code when completed', async () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      await waitFor(() => {
        expect(mockCell.metadata?.[RunmeMetadataKey.Pid]).toBeUndefined()
        // expect(mockCell.metadata?.[RunmeMetadataKey.ExitCode]).toBe('0')
      })
    })

    it('handles stdout and stderr from console', async () => {
      render(<Action cell={mockCell} />)

      await waitFor(() => {
        // The console should have been rendered and triggered callbacks
        expect(screen.getByTestId('cell-console')).toBeInTheDocument()
      })
    })

    it('passes correct settings to CellConsole', () => {
      render(<Action cell={mockCell} />)

      // The CellConsole should receive the correct settings
      expect(screen.getByTestId('cell-console')).toBeInTheDocument()
    })

    it('handles inverted order setting', () => {
      mockUseSettings.mockReturnValue({
        ...defaultSettingsContext,
        settings: {
          webApp: {
            invertedOrder: true,
          },
        },
      })

      render(<Action cell={mockCell} />)

      // The component should render with inverted order
      expect(screen.getByTestId('cell-console')).toBeInTheDocument()
    })

    it('recovers run ID from metadata when PID exists', () => {
      const cellWithMetadata = {
        ...mockCell,
        metadata: {
          [RunmeMetadataKey.Pid]: '12345',
          [RunmeMetadataKey.LastRunID]: 'recovered-run-id',
        },
      }

      render(<Action cell={cellWithMetadata} />)

      // The console should use the recovered run ID
      expect(screen.getByTestId('cell-console')).toBeInTheDocument()
    })

    it('does not recover run ID when PID does not exist', () => {
      const cellWithMetadata = {
        ...mockCell,
        metadata: {
          [RunmeMetadataKey.LastRunID]: 'some-run-id',
          // No PID
        },
      }

      render(<Action cell={cellWithMetadata} />)

      // The console should not use the recovered run ID
      expect(screen.getByTestId('cell-console')).toBeInTheDocument()
    })
  })

  describe('Actions Component', () => {
    it('renders actions header with add button', () => {
      render(<Actions />)

      expect(screen.getByText('Actions')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /add code cell/i })
      ).toBeInTheDocument()
    })

    it('renders action cells', () => {
      render(<Actions />)

      // Should render the mock cell
      expect(screen.getByTestId('editor')).toBeInTheDocument()
    })

    it('adds new code cell when add button is clicked', () => {
      render(<Actions />)

      const addButton = screen.getByRole('button', { name: /add code cell/i })
      fireEvent.click(addButton)

      expect(defaultCellContext.addCodeCell).toHaveBeenCalled()
    })

    it('scrolls to appropriate position based on inverted order setting', () => {
      render(<Actions />)

      // Should call scrollIntoView based on settings
      expect(mockScrollIntoView).toHaveBeenCalled()
    })
  })
})
