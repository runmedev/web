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
import { clone, create } from '@bufbuild/protobuf'
import { v4 as uuidv4 } from 'uuid'

import { createConnectClient, parser_pb, runner_pb } from '../runme/client'
import { SessionStorage } from '../storage'
import { getAccessToken } from '../token'
import { useClient as useAgentClient } from './AgentContext'
import { useSettings } from './SettingsContext'

type CellContextType = {
  // useColumns returns arrays of cells organized by their kind
  useColumns: () => {
    chat: parser_pb.Cell[]
    actions: parser_pb.Cell[]
    files: parser_pb.Cell[]
  }

  // sequence is a monotonically increasing number that is used to track the order of cells
  sequence: number
  // incrementSequence increments the sequence number
  incrementSequence: () => void

  exportDocument: () => Promise<void>
  // Define additional functions to update the state
  // This way they can be set in the provider and passed down to the components
  sendOutputCell: (outputCell: parser_pb.Cell) => Promise<void>
  createOutputCell: (inputCell: parser_pb.Cell) => parser_pb.Cell
  sendUserCell: (text: string) => Promise<void>
  addCodeCell: () => void
  // Keep track of whether the input is disabled
  isInputDisabled: boolean
  isTyping: boolean
  // Function to run a code cell
  runCodeCell: (cell: parser_pb.Cell) => void
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
  cells: Record<string, parser_pb.Cell>
  positions: string[]
}

// Utility function to always return cells in ascending order
function getAscendingCells(
  state: CellState,
  invertedOrder: boolean
): parser_pb.Cell[] {
  const cells = state.positions.map((id) => {
    const c = state.cells[id]
    c.languageId = 'sh'
    return c
  })
  if (cells.length === 0) {
    return []
  }
  if (invertedOrder) {
    return cells.reverse()
  }
  return cells
}

export const CellProvider = ({ children }: { children: ReactNode }) => {
  const { settings, principal } = useSettings()
  const [sequence, setSequence] = useState(0)
  const [isInputDisabled, setIsInputDisabled] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [activeSession, setActiveSession] = useState<string | undefined>()
  const [previousResponseId, setPreviousResponseId] = useState<
    string | undefined
  >()

  const storage = useMemo(() => {
    if (!principal) {
      return
    }
    console.log('principal', principal)
    return new SessionStorage(
      'agent',
      principal,
      createConnectClient(runner_pb.RunnerService, settings.agentEndpoint)
    )
  }, [settings.agentEndpoint, principal])

  useEffect(() => {
    storage?.listActiveSessions().then((ids) => {
      console.log('ids', ids)
    })
    storage?.createSession().then((id) => setActiveSession(id))
  }, [storage])

  useEffect(() => {
    if (!activeSession) {
      return
    }
    console.log('activeSession', activeSession)
  }, [activeSession])

  const incrementSequence = () => {
    setSequence((prev) => prev + 1)
  }

  const invertedOrder = useMemo(
    () => settings.webApp.invertedOrder,
    [settings.webApp.invertedOrder]
  )

  const { client } = useAgentClient()
  const [state, setState] = useState<CellState>({
    cells: {},
    positions: [],
  })

  useEffect(() => {
    if (!activeSession) {
      return
    }
    const cells = getAscendingCells(state, invertedOrder)
    const session = create(parser_pb.NotebookSchema, {
      cells,
    })
    storage?.saveNotebook(activeSession, session)
  }, [activeSession, state, storage, invertedOrder])

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
        (cell): cell is parser_pb.Cell =>
          Boolean(cell) &&
          (cell.kind === parser_pb.CellKind.MARKUP ||
            cell.kind === parser_pb.CellKind.CODE)
      )
  }, [state.cells, state.positions])

  const actionCells = useMemo(() => {
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is parser_pb.Cell =>
          Boolean(cell) && cell.kind === parser_pb.CellKind.CODE
      )
  }, [state.cells, state.positions])

  const fileCells = useMemo(() => {
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is parser_pb.Cell =>
          Boolean(cell) && cell.kind === parser_pb.CellKind.DOC_RESULTS
      )
  }, [state.cells, state.positions])

  const useColumns = () => {
    return {
      chat: chatCells,
      actions: actionCells,
      files: fileCells,
    }
  }

  const createOutputCell = (inputCell: parser_pb.Cell) => {
    const b = clone(parser_pb.CellSchema, inputCell)
    return b
  }

  const streamGenerateResults = async (cells: parser_pb.Cell[]) => {
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

    const userCell = create(parser_pb.CellSchema, {
      refId: `user_${uuidv4()}`,
      role: parser_pb.CellRole.USER,
      kind: parser_pb.CellKind.MARKUP,
      value: text,
    })

    // Add the user cell to the cells map and positions
    updateCell(userCell)
    setIsInputDisabled(true)
    setIsTyping(true)

    await streamGenerateResults([userCell])
  }

  const sendOutputCell = async (outputCell: parser_pb.Cell) => {
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

  const updateCell = (cell: parser_pb.Cell) => {
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
    const cell = create(parser_pb.CellSchema, {
      refId: `code_${uuidv4()}`,
      role: parser_pb.CellRole.USER,
      kind: parser_pb.CellKind.CODE,
      value: '',
    })

    updateCell(cell)
  }

  const runCodeCell = (cell: parser_pb.Cell) => {
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

  // todo(sebastian): quick and dirty export implementation
  const exportDocument = async () => {
    const cells = getAscendingCells(state, invertedOrder)
    if (cells.length === 0) {
      return
    }

    const notebook = create(parser_pb.NotebookSchema, {
      cells,
    })

    const c = createConnectClient(
      parser_pb.ParserService,
      settings.agentEndpoint
    )
    const req = create(parser_pb.SerializeRequestSchema, {
      notebook: notebook,
      options: create(parser_pb.SerializeRequestOptionsSchema, {
        outputs: create(parser_pb.SerializeRequestOutputOptionsSchema, {
          // todo(sebastian): will only work if we populate the outputs
          enabled: false,
          summary: false,
        }),
      }),
    })
    const resp = await c.serialize(req)
    const blob = new Blob([resp.result], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Session-${new Date().toISOString()}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <CellContext.Provider
      value={{
        useColumns,
        sequence,
        incrementSequence,
        exportDocument,
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

const TypingCell = create(parser_pb.CellSchema, {
  kind: parser_pb.CellKind.MARKUP,
  role: parser_pb.CellRole.ASSISTANT,
  value: '...',
})

enum MimeType {
  StatefulRunmeOutputItems = 'stateful.runme/output-items',
  StatefulRunmeTerminal = 'stateful.runme/terminal',
  VSCodeNotebookStdOut = 'application/vnd.code.notebook.stdout',
  VSCodeNotebookStdErr = 'application/vnd.code.notebook.stderr',
}

// eslint-disable-next-line react-refresh/only-export-components
export { parser_pb, TypingCell, MimeType }
