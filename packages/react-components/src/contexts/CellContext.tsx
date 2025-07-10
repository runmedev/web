import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  GenerateRequest,
  GenerateRequestSchema,
} from '@buf/stateful_runme.bufbuild_es/agent/v1/service_pb'
import {
  Cell,
  CellKind,
  CellOutputItemSchema,
  CellOutputSchema,
  CellRole,
  CellSchema,
} from '@buf/stateful_runme.bufbuild_es/runme/parser/v1/parser_pb'
import { clone, create } from '@bufbuild/protobuf'
import { v4 as uuidv4 } from 'uuid'

import { getAccessToken } from '../token'
import { useClient as useAgentClient } from './AgentContext'
import { useSettings } from './SettingsContext'

type CellContextType = {
  // useColumns returns arrays of cells organized by their kind
  useColumns: () => {
    chat: Cell[]
    actions: Cell[]
    files: Cell[]
  }

  // sequence is a monotonically increasing number that is used to track the order of cells
  sequence: number
  // incrementSequence increments the sequence number
  incrementSequence: () => void

  // Define additional functions to update the state
  // This way they can be set in the provider and passed down to the components
  sendOutputCell: (outputCell: Cell) => Promise<void>
  createOutputCell: (inputCell: Cell) => Cell
  sendUserCell: (text: string) => Promise<void>
  addCodeCell: () => void
  // Keep track of whether the input is disabled
  isInputDisabled: boolean
  isTyping: boolean
  // Function to run a code cell
  runCodeCell: (cell: Cell) => void
  // Function to reset the session
  resetSession: () => void
}

const CellContext = createContext<CellContextType | undefined>(undefined)

// eslint-disable-next-line react-refresh/only-export-components
export const useCell = () => {
  const context = useContext(CellContext)
  if (!context) {
    throw new Error('useCell must be used within a CellProvider')
  }
  return context
}

interface CellState {
  cells: Record<string, Cell>
  positions: string[]
}

export const CellProvider = ({ children }: { children: ReactNode }) => {
  const { settings } = useSettings()
  const [sequence, setSequence] = useState(0)
  const [isInputDisabled, setIsInputDisabled] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [previousResponseId, setPreviousResponseId] = useState<
    string | undefined
  >()

  const incrementSequence = () => {
    setSequence((prev) => prev + 1)
  }

  const { client } = useAgentClient()
  const [state, setState] = useState<CellState>({
    cells: {},
    positions: [],
  })

  const invertedOrder = useMemo(
    () => settings.webApp.invertedOrder,
    [settings.webApp.invertedOrder]
  )

  useEffect(() => {
    setState((prev) => {
      return {
        ...prev,
        positions: [...prev.positions].reverse(),
      }
    })
  }, [invertedOrder])

  const chatCells = useMemo(() => {
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is Cell =>
          Boolean(cell) &&
          (cell.kind === CellKind.MARKUP || cell.kind === CellKind.CODE)
      )
  }, [state.cells, state.positions])

  const actionCells = useMemo(() => {
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is Cell => Boolean(cell) && cell.kind === CellKind.CODE
      )
  }, [state.cells, state.positions])

  const fileCells = useMemo(() => {
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is Cell =>
          Boolean(cell) && cell.kind === CellKind.DOC_RESULTS
      )
  }, [state.cells, state.positions])

  const useColumns = () => {
    return {
      chat: chatCells,
      actions: actionCells,
      files: fileCells,
    }
  }

  const createOutputCell = (inputCell: Cell) => {
    const b = clone(CellSchema, inputCell)
    b.outputs = inputCell.outputs.map((o) =>
      create(CellOutputSchema, {
        items: o.items.map((i) => create(CellOutputItemSchema, i)),
      })
    )
    return b
  }

  const streamGenerateResults = async (cells: Cell[]) => {
    const accessToken = getAccessToken()

    const req: GenerateRequest = create(GenerateRequestSchema, {
      cells,
      previousResponseId: previousResponseId,
    })

    req.openaiAccessToken = accessToken.accessToken
    if (!accessToken.accessToken) {
      console.error('No access token found')
    }

    try {
      const res = client!.generate(req)
      for await (const r of res) {
        for (const b of r.cells) {
          setIsTyping(false)
          updateCell(b)
        }
        setPreviousResponseId(r.responseId)
      }
    } catch (e) {
      console.log(e)
    } finally {
      setIsTyping(false)
      setIsInputDisabled(false)
    }
  }

  const sendUserCell = async (text: string) => {
    if (!text.trim()) return

    const userCell = create(CellSchema, {
      refId: `user_${uuidv4()}`,
      role: CellRole.USER,
      kind: CellKind.MARKUP,
      value: text,
    })

    // Add the user cell to the cells map and positions
    updateCell(userCell)
    setIsInputDisabled(true)
    setIsTyping(true)

    await streamGenerateResults([userCell])
  }

  const sendOutputCell = async (outputCell: Cell) => {
    if (outputCell.outputs.length === 0) {
      return
    }

    console.log(
      'sending output cell',
      outputCell.refId,
      'previousResponseId',
      previousResponseId
    )
    setIsInputDisabled(true)
    setIsTyping(true)

    await streamGenerateResults([outputCell])
  }

  const updateCell = (cell: Cell) => {
    setState((prev) => {
      if (!prev.cells[cell.refId]) {
        const newPositions = invertedOrder
          ? [cell.refId, ...prev.positions]
          : [...prev.positions, cell.refId]
        return {
          cells: {
            ...prev.cells,
            [cell.refId]: cell,
          },
          positions: newPositions,
        }
      }

      return {
        ...prev,
        cells: {
          ...prev.cells,
          [cell.refId]: cell,
        },
      }
    })
  }

  const resetSession = () => {
    setState({ cells: {}, positions: [] })
    setSequence(0)
    setPreviousResponseId(undefined)
  }

  const addCodeCell = () => {
    const cell = create(CellSchema, {
      refId: `code_${uuidv4()}`,
      role: CellRole.USER,
      kind: CellKind.CODE,
      value: '',
    })

    updateCell(cell)
  }

  const runCodeCell = (cell: Cell) => {
    // Find the corresponding action cell and trigger its runCode function
    const actionCell = actionCells.find((b) => b.refId === cell.refId)
    if (actionCell) {
      // This will be handled by the Action component
      const event = new CustomEvent('runCodeCell', {
        detail: { cellId: cell.refId },
      })
      window.dispatchEvent(event)
    }
  }

  return (
    <CellContext.Provider
      value={{
        useColumns,
        sequence,
        incrementSequence,
        sendOutputCell,
        createOutputCell,
        sendUserCell,
        addCodeCell,
        isInputDisabled,
        isTyping,
        runCodeCell,
        resetSession,
      }}
    >
      {children}
    </CellContext.Provider>
  )
}

const TypingCell = create(CellSchema, {
  kind: CellKind.MARKUP,
  role: CellRole.ASSISTANT,
  value: '...',
})

enum MimeType {
  StatefulRunmeOutputItems = 'stateful.runme/output-items',
  StatefulRunmeTerminal = 'stateful.runme/terminal',
  VSCodeNotebookStdOut = 'application/vnd.code.notebook.stdout',
  VSCodeNotebookStdErr = 'application/vnd.code.notebook.stderr',
}

export { type Cell, CellRole, CellKind, TypingCell, MimeType }
