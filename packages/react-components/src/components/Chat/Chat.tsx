import { memo, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'

import { Button, Flex, ScrollArea, Text, TextArea } from '@radix-ui/themes'

import { TypingCell, parser_pb, useCell } from '../../contexts/CellContext'
import { useSettings } from '../../contexts/SettingsContext'
import { SubmitQuestionIcon } from '../Actions/icons'

type MessageProps = {
  cell: parser_pb.Cell
}

const MessageContainer = ({
  role,
  children,
}: {
  role: parser_pb.CellRole
  children: React.ReactNode
}) => {
  const self = role === parser_pb.CellRole.USER ? 'self-end' : 'self-start'

  const messageStyle = {
    backgroundColor:
      role === parser_pb.CellRole.USER ? 'var(--accent-9)' : 'var(--gray-4)',
    color:
      role === parser_pb.CellRole.USER
        ? 'var(--accent-contrast)'
        : 'var(--gray-background)',
    border:
      role === parser_pb.CellRole.USER
        ? '1px solid var(--accent-7)'
        : '1px solid var(--gray-1)',
  }

  console.log(messageStyle)

  return (
    <div
      className={`${self} max-w-[80%] break-words m-1 p-3 rounded-lg`}
      style={messageStyle}
    >
      {children}
    </div>
  )
}

const UserMessage = ({ cell }: { cell: parser_pb.Cell }) => {
  return (
    <MessageContainer role={parser_pb.CellRole.USER}>
      {cell.value}
    </MessageContainer>
  )
}

const AssistantMessage = ({ cell }: { cell: parser_pb.Cell }) => {
  return (
    <MessageContainer role={parser_pb.CellRole.ASSISTANT}>
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
        {cell.value}
      </Markdown>
    </MessageContainer>
  )
}

const CodeMessage = memo(
  ({
    cell,
    isRecentCodeCell,
    onClick,
  }: {
    cell: parser_pb.Cell
    isRecentCodeCell?: boolean
    onClick?: () => void
  }) => {
    const { runCodeCell } = useCell()
    const { settings } = useSettings()
    const firstLine =
      cell.value?.split(/&&|;|\n|\\n/)[0]?.substring(0, 50) || ''

    const handleClick = () => {
      if (onClick) {
        onClick()
      } else {
        runCodeCell(cell)
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
        {isRecentCodeCell && settings.webApp.invertedOrder && shortcut}
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
        {isRecentCodeCell && !settings.webApp.invertedOrder && shortcut}
      </div>
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.cell.refId === nextProps.cell.refId &&
      JSON.stringify(prevProps.cell.value) ===
        JSON.stringify(nextProps.cell.value) &&
      prevProps.isRecentCodeCell === nextProps.isRecentCodeCell
    )
  }
)

const Message = ({
  cell,
  isRecentCodeCell,
}: MessageProps & { isRecentCodeCell?: boolean }) => {
  if (cell.kind === parser_pb.CellKind.CODE) {
    return (
      <CodeMessage
        key={cell.refId}
        cell={cell}
        isRecentCodeCell={isRecentCodeCell}
      />
    )
  }

  switch (cell.role) {
    case parser_pb.CellRole.USER:
      return <UserMessage cell={cell} />
    case parser_pb.CellRole.ASSISTANT:
      return <AssistantMessage cell={cell} />
    default:
      return null
  }
}

const ChatMessages = () => {
  const { useColumns, isTyping } = useCell()
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

  const typingCell = (
    <div className={`flex ${typingJustification} items-center h-full`}>
      <Message cell={TypingCell} />
    </div>
  )

  return (
    <div className="overflow-y-clip p-1 flex flex-col whitespace-pre-wrap">
      {isTyping && settings.webApp.invertedOrder && typingCell}
      {chat.map((msg: parser_pb.Cell, index: number) => (
        <Message
          key={index}
          cell={msg}
          isRecentCodeCell={
            msg.kind === parser_pb.CellKind.CODE &&
            index === recentIndex &&
            !isTyping
          }
        />
      ))}
      {isTyping && !settings.webApp.invertedOrder && typingCell}
      <div ref={messagesEndRef} />
    </div>
  )
}

const ChatInput = () => {
  const { sendUserCell, isInputDisabled } = useCell()
  const [userInput, setUserInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!userInput.trim()) return
    sendUserCell(userInput)
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
  const { useColumns, runCodeCell } = useCell()
  const { settings } = useSettings()
  const { chat } = useColumns()
  const outerDivRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'Enter') {
        const cellToRun = settings.webApp.invertedOrder
          ? chat[0]
          : chat[chat.length - 1]
        if (cellToRun?.kind === parser_pb.CellKind.CODE) {
          runCodeCell(cellToRun)
        }
      }
    }

    const outerDiv = outerDivRef.current
    if (outerDiv) {
      outerDiv.addEventListener('keydown', handleKeyDown)
      return () => outerDiv.removeEventListener('keydown', handleKeyDown)
    }
  }, [chat, runCodeCell, settings.webApp.invertedOrder])

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
