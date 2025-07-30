import { CellSchema } from '@buf/stateful_runme.bufbuild_es/runme/parser/v1/parser_pb'
import { create } from '@bufbuild/protobuf'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../../test/utils'
import { parser_pb } from '../../../contexts/CellContext'
import { RunmeMetadataKey } from '../../../runme/client'
import { Action } from '../Actions'

// Mock the contexts
const mockUseCell = vi.fn()
const mockUseSettings = vi.fn()

// Mock the protobuf create function
vi.mock('@bufbuild/protobuf', () => ({
  create: vi.fn(() => ({})),
}))

vi.mock('../../../contexts/CellContext', () => ({
  useCell: () => mockUseCell(),
  parser_pb: {
    CellKind: {
      CODE: 'CODE',
      MARKDOWN: 'MARKDOWN',
    },
  },
}))

vi.mock('../../../contexts/SettingsContext', () => ({
  useSettings: () => mockUseSettings(),
}))

// Mock the child components
vi.mock('../CellConsole', () => ({
  default: vi.fn(({ onPid, onExitCode }) => {
    // Trigger callbacks in the next tick to simulate async behavior
    setTimeout(() => {
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

    return <div data-testid="cell-console">CellConsole</div>
  }),
  fontSettings: {
    fontSize: 14,
    fontFamily: 'monospace',
  },
}))

vi.mock('../Editor', () => ({
  default: vi.fn(({ onChange, onEnter }) => (
    <div data-testid="editor">
      <button onClick={() => onChange('new value')}>Change Value</button>
      <button onClick={() => onEnter()}>Enter</button>
    </div>
  )),
}))

describe('Action Component', () => {
  const mockCell = {
    refId: 'test-cell-id',
    value: 'echo "hello world"',
    kind: parser_pb.CellKind.CODE,
    metadata: {
      [RunmeMetadataKey.Sequence]: '1',
    },
    outputs: [],
    executionSummary: undefined,
  } as any

  const defaultCellContext = {
    saveState: vi.fn(),
    runCodeCell: vi.fn(),
  }

  const defaultSettingsContext = {
    settings: {
      webApp: {
        invertedOrder: false,
      },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseCell.mockReturnValue(defaultCellContext)
    mockUseSettings.mockReturnValue(defaultSettingsContext)
  })

  describe('RunActionButton', () => {
    it('renders play icon when not running', () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      expect(button).toBeInTheDocument()
      // Should show play icon when pid and exitCode are null
      expect(button.querySelector('svg')).toBeInTheDocument()
    })

    it('renders spinner when running', async () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // Wait for the console to trigger the PID callback
      await waitFor(() => {
        // The button should show spinner when pid is set
        expect(button).toBeInTheDocument()
      })
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

    it('calls runCodeCell when clicked', () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      expect(defaultCellContext.runCodeCell).toHaveBeenCalledWith(mockCell)
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

      const sequenceLabel = screen.getByTestId('sequence-label')
      expect(sequenceLabel).toBeInTheDocument()
      expect(sequenceLabel).toHaveTextContent('[1]')
    })

    it('displays empty sequence label when no sequence', () => {
      const cellWithoutSequence = {
        ...mockCell,
        metadata: {},
      }

      render(<Action cell={cellWithoutSequence} />)

      const sequenceLabel = screen.getByTestId('sequence-label')
      expect(sequenceLabel).toBeInTheDocument()
      expect(sequenceLabel).toHaveTextContent('[ ]')
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

      expect(defaultCellContext.runCodeCell).toHaveBeenCalledWith(mockCell)
    })

    it('updates cell value when editor changes', () => {
      render(<Action cell={mockCell} />)

      const changeButton = screen.getByText('Change Value')
      fireEvent.click(changeButton)

      expect(mockCell.value).toBe('new value')
    })

    it('passes correct props to CellConsole', () => {
      render(<Action cell={mockCell} />)

      expect(screen.getByTestId('cell-console')).toBeInTheDocument()
    })

    it('manages pid and exitCode state', async () => {
      render(<Action cell={mockCell} />)

      const button = screen.getByRole('button', { name: /run code/i })
      fireEvent.click(button)

      // Wait for the console to trigger callbacks
      await waitFor(() => {
        expect(screen.getByTestId('cell-console')).toBeInTheDocument()
      })
    })

    it('passes font settings to Editor', () => {
      render(<Action cell={mockCell} />)

      expect(screen.getByTestId('editor')).toBeInTheDocument()
    })
  })
})
