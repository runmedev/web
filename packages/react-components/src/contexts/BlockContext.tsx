import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  Block,
  BlockKind,
  BlockOutputItemSchema,
  BlockOutputKind,
  BlockOutputSchema,
  BlockRole,
  BlockSchema,
  GenerateRequest,
  GenerateRequestSchema,
} from '@buf/stateful_runme.bufbuild_es/agent/blocks_pb'
import { clone, create } from '@bufbuild/protobuf'
import { v4 as uuidv4 } from 'uuid'

import { getAccessToken } from '../token'
import { useClient as useAgentClient } from './AgentContext'
import { useSettings } from './SettingsContext'

type BlockContextType = {
  // useColumns returns arrays of blocks organized by their kind
  useColumns: () => {
    chat: Block[]
    actions: Block[]
    files: Block[]
  }

  // sequence is a monotonically increasing number that is used to track the order of blocks
  sequence: number
  // incrementSequence increments the sequence number
  incrementSequence: () => void

  // Define additional functions to update the state
  // This way they can be set in the provider and passed down to the components
  sendOutputBlock: (outputBlock: Block) => Promise<void>
  createOutputBlock: (inputBlock: Block) => Block
  sendUserBlock: (text: string) => Promise<void>
  addCodeBlock: () => void
  // Keep track of whether the input is disabled
  isInputDisabled: boolean
  isTyping: boolean
  // Function to run a code block
  runCodeBlock: (block: Block) => void
  // Function to reset the session
  resetSession: () => void
}

const BlockContext = createContext<BlockContextType | undefined>(undefined)

// eslint-disable-next-line react-refresh/only-export-components
export const useBlock = () => {
  const context = useContext(BlockContext)
  if (!context) {
    throw new Error('useBlock must be used within a BlockProvider')
  }
  return context
}

interface BlockState {
  blocks: Record<string, Block>
  positions: string[]
}

export const BlockProvider = ({ children }: { children: ReactNode }) => {
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
  const [state, setState] = useState<BlockState>({
    blocks: {},
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

  const chatBlocks = useMemo(() => {
    return state.positions
      .map((id) => state.blocks[id])
      .filter(
        (block): block is Block =>
          Boolean(block) &&
          (block.kind === BlockKind.MARKUP || block.kind === BlockKind.CODE)
      )
  }, [state.blocks, state.positions])

  const actionBlocks = useMemo(() => {
    return state.positions
      .map((id) => state.blocks[id])
      .filter(
        (block): block is Block =>
          Boolean(block) && block.kind === BlockKind.CODE
      )
  }, [state.blocks, state.positions])

  const fileBlocks = useMemo(() => {
    return state.positions
      .map((id) => state.blocks[id])
      .filter(
        (block): block is Block =>
          Boolean(block) && block.kind === BlockKind.FILE_SEARCH_RESULTS
      )
  }, [state.blocks, state.positions])

  const useColumns = () => {
    return {
      chat: chatBlocks,
      actions: actionBlocks,
      files: fileBlocks,
    }
  }

  const createOutputBlock = (inputBlock: Block) => {
    const b = clone(BlockSchema, inputBlock)
    b.outputs = inputBlock.outputs.map((o) =>
      create(BlockOutputSchema, {
        items: o.items.map((i) => create(BlockOutputItemSchema, i)),
        kind: o.kind,
      })
    )
    return b
  }

  const streamGenerateResults = async (blocks: Block[]) => {
    const accessToken = getAccessToken()

    const req: GenerateRequest = create(GenerateRequestSchema, {
      blocks,
      previousResponseId: previousResponseId,
    })

    req.openaiAccessToken = accessToken.accessToken
    if (!accessToken.accessToken) {
      console.error('No access token found')
    }

    try {
      const res = client!.generate(req)
      for await (const r of res) {
        for (const b of r.blocks) {
          setIsTyping(false)
          updateBlock(b)
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

  const sendUserBlock = async (text: string) => {
    if (!text.trim()) return

    const userBlock = create(BlockSchema, {
      id: `user_${uuidv4()}`,
      role: BlockRole.USER,
      kind: BlockKind.MARKUP,
      contents: text,
    })

    // Add the user block to the blocks map and positions
    updateBlock(userBlock)
    setIsInputDisabled(true)
    setIsTyping(true)

    await streamGenerateResults([userBlock])
  }

  const sendOutputBlock = async (outputBlock: Block) => {
    if (outputBlock.outputs.length === 0) {
      return
    }

    console.log(
      'sending output block',
      outputBlock.id,
      'previousResponseId',
      previousResponseId
    )
    setIsInputDisabled(true)
    setIsTyping(true)

    await streamGenerateResults([outputBlock])
  }

  const updateBlock = (block: Block) => {
    setState((prev) => {
      if (!prev.blocks[block.id]) {
        const newPositions = invertedOrder
          ? [block.id, ...prev.positions]
          : [...prev.positions, block.id]
        return {
          blocks: {
            ...prev.blocks,
            [block.id]: block,
          },
          positions: newPositions,
        }
      }

      return {
        ...prev,
        blocks: {
          ...prev.blocks,
          [block.id]: block,
        },
      }
    })
  }

  const resetSession = () => {
    setState({ blocks: {}, positions: [] })
    setSequence(0)
    setPreviousResponseId(undefined)
  }

  const addCodeBlock = () => {
    const block = create(BlockSchema, {
      id: `code_${uuidv4()}`,
      role: BlockRole.USER,
      kind: BlockKind.CODE,
      contents: '',
    })

    updateBlock(block)
  }

  const runCodeBlock = (block: Block) => {
    // Find the corresponding action block and trigger its runCode function
    const actionBlock = actionBlocks.find((b) => b.id === block.id)
    if (actionBlock) {
      // This will be handled by the Action component
      const event = new CustomEvent('runCodeBlock', {
        detail: { blockId: block.id },
      })
      window.dispatchEvent(event)
    }
  }

  return (
    <BlockContext.Provider
      value={{
        useColumns,
        sequence,
        incrementSequence,
        sendOutputBlock,
        createOutputBlock,
        sendUserBlock,
        addCodeBlock,
        isInputDisabled,
        isTyping,
        runCodeBlock,
        resetSession,
      }}
    >
      {children}
    </BlockContext.Provider>
  )
}

const TypingBlock = create(BlockSchema, {
  kind: BlockKind.MARKUP,
  role: BlockRole.ASSISTANT,
  contents: '...',
})

export { type Block, BlockRole, BlockKind, BlockOutputKind, TypingBlock }
