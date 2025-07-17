import {
  ReactNode,
  createContext,
  useCallback,
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

import {
  AgentMetadataKey,
  RunmeMetadataKey,
  createConnectClient,
  parser_pb,
  runner_pb,
} from '../runme/client'
import { SessionStorage, generateSessionName } from '../storage'
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

  // saveState saves the current state to the storage, runs sync because it schedules a debounced save
  saveState: () => void
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
  resetSession: (options: { attemptRestore: boolean }) => void
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
  runmeSession: string
  cells: Record<string, parser_pb.Cell>
  positions: string[]
}

// Utility function to always return cells in ascending order
function getAscendingCells(
  state: CellState | undefined,
  invertedOrder: boolean
): parser_pb.Cell[] {
  if (!state) {
    return []
  }

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

  const incrementSequence = () => {
    setSequence((prev) => prev + 1)
  }

  const invertedOrder = useMemo(
    () => settings.webApp.invertedOrder,
    [settings.webApp.invertedOrder]
  )

  const { client } = useAgentClient()
  const [state, setState] = useState<CellState | undefined>(undefined)

  const saveState = useCallback(() => {
    if (!state) {
      return
    }
    const cells = getAscendingCells(state, invertedOrder)
    const session = create(parser_pb.NotebookSchema, {
      cells,
    })
    if (previousResponseId) {
      session.metadata[AgentMetadataKey.PreviousResponseId] = previousResponseId
    }
    storage?.saveNotebook(state.runmeSession, session)
  }, [state, invertedOrder, previousResponseId, storage])

  const resetSession = useCallback(
    async ({ attemptRestore }: { attemptRestore: boolean }) => {
      if (!storage) {
        return
      }

      setSequence(0)
      setPreviousResponseId(undefined)

      // Create session async, we decide later if we want to use it
      const newSess = storage.createSession()
      let activeSessionID: string | undefined

      // Unless we are attempting to restore, short circuit and create a new session
      if (!attemptRestore) {
        activeSessionID = await newSess
      } else {
        const sessionIds = await storage.listActiveSessions()
        const sessions = await storage.loadSessions(sessionIds)

        // Filter out sessions that are empty or have only finished cells
        const activeSessions = sessions.filter((session) => {
          return session.data.cells.length !== 0

          // todo(sebastian): do we need this? we auto-restore the last session if still active
          // Check if any cell is still running (has a PID but no exit code)
          // return session.data.cells.some((cell) => {
          //   const exitCode = Number(cell.metadata[RunmeMetadataKey.ExitCode])
          //   const pid = Number(cell.metadata[RunmeMetadataKey.Pid])
          //   if (pid && Number.isFinite(pid) && !Number.isFinite(exitCode)) {
          //     return true
          //   }
          //   return false
          // })
        })

        // If there are no unfinished sessions, create a new session
        if (activeSessions.length === 0) {
          activeSessionID = await newSess
        } else {
          const recovSess = activeSessions[0]
          let positions = recovSess.data.cells.map((cell) => cell.refId)
          if (invertedOrder) {
            positions = positions.reverse()
          }
          const prevRespId =
            recovSess.data.metadata[AgentMetadataKey.PreviousResponseId]
          if (prevRespId) {
            setPreviousResponseId(prevRespId)
          }
          setState({
            runmeSession: recovSess.id,
            cells: recovSess.data.cells.reduce(
              (acc, cell) => {
                acc[cell.refId] = cell
                return acc
              },
              {} as Record<string, parser_pb.Cell>
            ),
            positions,
          })
          return
        }
      }

      setState({
        runmeSession: activeSessionID!,
        cells: {},
        positions: [],
      })
    },
    [invertedOrder, storage]
  )

  // Any time state changes, save the current state
  useEffect(() => {
    saveState()
  }, [state, storage, invertedOrder, saveState])

  useEffect(() => {
    setState((prev) => {
      return {
        runmeSession: prev?.runmeSession ?? '',
        cells: prev?.cells ?? {},
        positions: [...(prev?.positions ?? [])].reverse(),
      }
    })
  }, [invertedOrder])

  useEffect(() => {
    if (!resetSession) {
      return
    }
    resetSession({ attemptRestore: true })
  }, [resetSession])

  const chatCells = useMemo(() => {
    if (!state) {
      return []
    }
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is parser_pb.Cell =>
          Boolean(cell) &&
          (cell.kind === parser_pb.CellKind.MARKUP ||
            cell.kind === parser_pb.CellKind.CODE)
      )
  }, [state])

  const actionCells = useMemo(() => {
    if (!state) {
      return []
    }
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is parser_pb.Cell =>
          Boolean(cell) && cell.kind === parser_pb.CellKind.CODE
      )
  }, [state])

  const fileCells = useMemo(() => {
    if (!state) {
      return []
    }
    return state.positions
      .map((id) => state.cells[id])
      .filter(
        (cell): cell is parser_pb.Cell =>
          Boolean(cell) && cell.kind === parser_pb.CellKind.DOC_RESULTS
      )
  }, [state])

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
      previousResponseId,
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
      if (!prev) {
        return undefined
      }
      if (!prev.cells[cell.refId]) {
        const newPositions = invertedOrder
          ? [cell.refId, ...prev.positions]
          : [...prev.positions, cell.refId]
        return {
          runmeSession: prev.runmeSession,
          cells: {
            ...prev.cells,
            [cell.refId]: cell,
          },
          positions: newPositions,
        }
      }

      return {
        ...prev,
        runmeSession: prev.runmeSession,
        cells: {
          ...prev.cells,
          [cell.refId]: cell,
        },
      }
    })
  }

  const addCodeCell = () => {
    const refID = `code_${uuidv4().replace(/-/g, '')}`
    const cell = create(parser_pb.CellSchema, {
      metadata: {
        [RunmeMetadataKey.ID]: refID,
        [RunmeMetadataKey.RunmeID]: refID,
      },
      refId: refID,
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
    if (!state || cells.length === 0) {
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
    a.download = `${generateSessionName()}.md`
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
        saveState,
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

// eslint-disable-next-line react-refresh/only-export-components
export { parser_pb, TypingCell }
