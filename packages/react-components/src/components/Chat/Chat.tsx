import { memo, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'

import {
  Button,
  Callout,
  Flex,
  ScrollArea,
  Text,
  TextArea,
} from '@radix-ui/themes'

import {
  Block,
  BlockKind,
  BlockRole,
  TypingBlock,
  useBlock,
} from '../../contexts/BlockContext'
import { useSettings } from '../../contexts/SettingsContext'
import { SubmitQuestionIcon } from '../Actions/icons'

type MessageProps = {
  block: Block
}

const MessageContainer = ({
  role,
  children,
}: {
  role: BlockRole
  children: React.ReactNode
}) => {
  const self = role === BlockRole.USER ? 'self-end' : 'self-start'
  const color = role === BlockRole.USER ? 'indigo' : 'gray'

  return (
    <Callout.Root
      highContrast
      color={color}
      className={`${self} max-w-[80%] break-words m-1`}
    >
      <Callout.Text>{children}</Callout.Text>
    </Callout.Root>
  )
}

const UserMessage = ({ block }: { block: Block }) => {
  return (
    <MessageContainer role={BlockRole.USER}>{block.contents}</MessageContainer>
  )
}

const AssistantMessage = ({ block }: { block: Block }) => {
  return (
    <MessageContainer role={BlockRole.ASSISTANT}>
      <Markdown
        components={{
          code: ({ children, ...props }) => {
            return (
              <pre className="whitespace-pre-wrap">
                <code {...props}>{String(children).replace(/\n$/, '')}</code>
              </pre>
            )
          },
        }}
      >
        {block.contents}
      </Markdown>
    </MessageContainer>
  )
}

const CodeMessage = memo(
  ({
    block,
    isRecentCodeBlock,
    onClick,
  }: {
    block: Block
    isRecentCodeBlock?: boolean
    onClick?: () => void
  }) => {
    const { runCodeBlock } = useBlock()
    const { settings } = useSettings()
    const firstLine =
      block.contents?.split(/&&|;|\n|\\n/)[0]?.substring(0, 50) || ''

    const handleClick = () => {
      if (onClick) {
        onClick()
      } else {
        runCodeBlock(block)
      }
    }

    const justification = settings.webApp.invertedOrder
      ? 'justify-end'
      : 'justify-start'

    const shortcut = (
      <span className="text-xs text-gray-400 p-2">Press CTRL+ENTER to run</span>
    )

    return (
      <div className={`flex ${justification} items-center h-full`}>
        {isRecentCodeBlock && settings.webApp.invertedOrder && shortcut}
        <div
          className="flex items-center m-1 p-2 bg-[#1e1e1e] rounded-md max-w-[60%] cursor-pointer"
          onClick={handleClick}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#d4d4d4"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#d4d4d4"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="ml-1"
          >
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          <span className="text-sm text-[#d4d4d4] italic truncate max-w-4/5">
            {firstLine}
          </span>
        </div>
        {isRecentCodeBlock && !settings.webApp.invertedOrder && shortcut}
      </div>
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.block.id === nextProps.block.id &&
      JSON.stringify(prevProps.block.contents) ===
        JSON.stringify(nextProps.block.contents) &&
      prevProps.isRecentCodeBlock === nextProps.isRecentCodeBlock
    )
  }
)

const Message = ({
  block,
  isRecentCodeBlock,
}: MessageProps & { isRecentCodeBlock?: boolean }) => {
  if (block.kind === BlockKind.CODE) {
    return (
      <CodeMessage
        key={block.id}
        block={block}
        isRecentCodeBlock={isRecentCodeBlock}
      />
    )
  }

  switch (block.role) {
    case BlockRole.USER:
      return <UserMessage block={block} />
    case BlockRole.ASSISTANT:
      return <AssistantMessage block={block} />
    default:
      return null
  }
}

const ChatMessages = () => {
  const { useColumns, isTyping } = useBlock()
  const { settings } = useSettings()
  const { chat } = useColumns()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (settings.webApp.invertedOrder) {
      return
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat, settings.webApp.invertedOrder])

  const recentIndex = settings.webApp.invertedOrder ? 0 : chat.length - 1

  const typingJustification = 'justify-start'

  const typingBlock = (
    <div className={`flex ${typingJustification} items-center h-full`}>
      <Message block={TypingBlock} />
    </div>
  )

  return (
    <div className="overflow-y-clip p-1 flex flex-col whitespace-pre-wrap">
      {isTyping && settings.webApp.invertedOrder && typingBlock}
      {chat.map((msg: Block, index: number) => (
        <Message
          key={index}
          block={msg}
          isRecentCodeBlock={
            msg.kind === BlockKind.CODE && index === recentIndex && !isTyping
          }
        />
      ))}
      {isTyping && !settings.webApp.invertedOrder && typingBlock}
      <div ref={messagesEndRef} />
    </div>
  )
}

const ChatInput = () => {
  const { sendUserBlock, isInputDisabled } = useBlock()
  const [userInput, setUserInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!userInput.trim()) return
    sendUserBlock(userInput)
    setUserInput('')
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const form = event.currentTarget.form
      if (form) {
        form.requestSubmit()
      }
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full">
      <Flex className="w-full flex flex-nowrap items-start gap-4 m-2">
        <TextArea
          name="userInput"
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter your question"
          size="3"
          className="flex-grow min-w-0"
          ref={inputRef}
          rows={2}
          style={{ resize: 'vertical' }}
        />
        <Button type="submit" disabled={isInputDisabled}>
          <SubmitQuestionIcon />
        </Button>
      </Flex>
    </form>
  )
}

function Chat() {
  const { useColumns, runCodeBlock } = useBlock()
  const { settings } = useSettings()
  const { chat } = useColumns()
  const outerDivRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'Enter') {
        const blockToRun = settings.webApp.invertedOrder
          ? chat[0]
          : chat[chat.length - 1]
        if (blockToRun?.kind === BlockKind.CODE) {
          runCodeBlock(blockToRun)
        }
      }
    }

    const outerDiv = outerDivRef.current
    if (outerDiv) {
      outerDiv.addEventListener('keydown', handleKeyDown)
      return () => outerDiv.removeEventListener('keydown', handleKeyDown)
    }
  }, [chat, runCodeBlock, settings.webApp.invertedOrder])

  const layout = settings.webApp.invertedOrder ? 'flex-col' : 'flex-col-reverse'

  return (
    <div ref={outerDivRef} className="flex flex-col h-full">
      <Text size="5" weight="bold" className="mb-2">
        How can I help you?
      </Text>
      <ScrollArea type="auto" scrollbars="vertical" className="flex-1 p-4">
        <div className={`flex ${layout} h-full w-full`}>
          {settings.webApp.invertedOrder ? (
            <>
              <ChatInput />
              <ChatMessages />
            </>
          ) : (
            <>
              <ChatInput />
              <ChatMessages />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export default Chat
