import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render } from '../../../../../test/utils'
import { parser_pb } from '../../../contexts/CellContext'
import { RunmeMetadataKey } from '../../../runme/client'
import Actions from '../Actions'

// Mock the protobuf create function
vi.mock('@bufbuild/protobuf', () => ({
  create: vi.fn(() => ({})),
}))

vi.mock('@runmedev/react-console', () => ({
  genRunID: vi.fn(() => 'mock-run-id'),
  Console: vi.fn(() => <div data-testid="console">Console Component</div>),
}))

// Mock the Action component to avoid calling the real one
vi.mock('../Actions', async () => {
  const actual = await vi.importActual('../Actions')
  return {
    ...actual,
    Action: vi.fn(({ cell }) => (
      <div data-testid={`action-${cell.refId}`}>Action Component</div>
    )),
  }
})

// Mock the contexts
const mockUseCell = vi.fn()
const mockUseSettings = vi.fn()
const mockUseOutput = vi.fn()

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

vi.mock('../../../contexts/OutputContext', () => ({
  useOutput: () => mockUseOutput(),
}))

// Mock scrollIntoView
const mockScrollIntoView = vi.fn()
Element.prototype.scrollIntoView = mockScrollIntoView

describe('Actions Component', () => {
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
    useColumns: () => ({
      actions: [mockCell],
      chat: [],
      files: [],
    }),
    addCodeCell: vi.fn(),
    saveState: vi.fn(),
    sendOutputCell: vi.fn(),
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

  const defaultOutputContext = {
    registerRenderer: vi.fn(),
    unregisterRenderer: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseCell.mockReturnValue(defaultCellContext)
    mockUseSettings.mockReturnValue(defaultSettingsContext)
    mockUseOutput.mockReturnValue(defaultOutputContext)
  })

  it('renders actions header with add button', () => {
    render(<Actions />)

    expect(screen.getByText('Actions')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /add code cell/i })
    ).toBeInTheDocument()
  })

  it('renders action cells', () => {
    render(<Actions />)

    // Should render the action cells
    expect(screen.getByTestId('sequence-label')).toBeInTheDocument()
  })

  it('adds new code cell when add button is clicked', () => {
    render(<Actions />)

    const addButton = screen.getByRole('button', { name: /add code cell/i })
    fireEvent.click(addButton)

    expect(defaultCellContext.addCodeCell).toHaveBeenCalled()
  })

  it('scrolls to end when inverted order is false', () => {
    render(<Actions />)

    // Should call scrollIntoView for the end ref when inverted order is false
    expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })
  })

  it('scrolls to start when inverted order is true', () => {
    mockUseSettings.mockReturnValue({
      ...defaultSettingsContext,
      settings: {
        webApp: {
          invertedOrder: true,
        },
      },
    })

    render(<Actions />)

    // Should call scrollIntoView for the start ref when inverted order is true
    expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })
  })

  it('renders multiple action cells', () => {
    const mockCell2 = {
      refId: 'test-cell-id-2',
      value: 'echo "second cell"',
      kind: parser_pb.CellKind.CODE,
      metadata: {},
      outputs: [],
      executionSummary: undefined,
    } as any

    mockUseCell.mockReturnValue({
      ...defaultCellContext,
      useColumns: () => ({
        actions: [mockCell, mockCell2],
        chat: [],
        files: [],
      }),
    })

    render(<Actions />)

    // Should render multiple action cells
    const sequenceLabels = screen.getAllByTestId('sequence-label')
    expect(sequenceLabels).toHaveLength(2)
  })

  it('registers terminal renderer for any code cell with empty outputs', () => {
    // Capture the registered renderer
    const registerCalls = mockUseOutput().registerRenderer.mock.calls
    // Render to trigger useEffect registration
    render(<Actions />)

    const callsAfterRender = mockUseOutput().registerRenderer.mock.calls
    const call = (callsAfterRender.length ? callsAfterRender : registerCalls)[0]
    expect(call).toBeDefined()

    const rendererConfig = call[1]
    expect(rendererConfig).toBeDefined()
    expect(typeof rendererConfig.onCellUpdate).toBe('function')

    const testCell: any = {
      refId: 'c1',
      kind: parser_pb.CellKind.CODE,
      languageId: 'python',
      outputs: [],
      metadata: {},
    }

    rendererConfig.onCellUpdate(testCell)

    expect(Array.isArray(testCell.outputs)).toBe(true)
    expect(testCell.outputs.length).toBe(1)
  })
})
