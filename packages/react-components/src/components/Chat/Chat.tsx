import { memo, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'

import { Button, Flex, ScrollArea, Text, TextArea } from '@radix-ui/themes'

import { TypingCell, parser_pb, useCell } from '../../contexts/CellContext'
import { useSettings } from '../../contexts/SettingsContext'
import { SubmitQuestionIcon } from '../Actions/icons'
import { Action } from '../Actions/Actions'
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary'

type MessageProps = {
  cell: parser_pb.Cell
}

const MessageContainer = ({
  role,
  kind,
  children,
}: {
  role: parser_pb.CellRole
  kind: parser_pb.CellKind
  children: React.ReactNode
}) => {
  const isUser = role === parser_pb.CellRole.USER
  const isTool = kind === parser_pb.CellKind.TOOL

  // Distinct styling for tool calls - more subtle than regular messages
  const containerClass = `${isUser ? 'self-end' : 'self-start'} max-w-[80%] break-words m-1 p-3`

  const baseStyle = {
    backgroundColor: isUser ? 'var(--accent-9)' : 'var(--gray-a5)',
    color: isUser ? 'var(--accent-contrast)' : 'var(--gray-background)',
    border: isUser ? '1px solid var(--accent-7)' : '1px solid var(--gray-1)',
    borderRadius: 'var(--radius-3)',
  }

  // Style tool calls with outline only - no background fill
  const toolStyle = isTool
    ? {
        backgroundColor: 'transparent',
        color: 'var(--gray-10)',
        border: '1px solid var(--gray-7)',
        borderRadius: 'var(--radius-3)',
        fontSize: '0.875rem',
      }
    : baseStyle

  return (
    <div className={containerClass} style={toolStyle}>
      {children}
    </div>
  )
}

const UserMessage = ({ cell }: { cell: parser_pb.Cell }) => {
  return (
    <MessageContainer role={parser_pb.CellRole.USER} kind={cell.kind}>
      {cell.value}
    </MessageContainer>
  )
}

const AssistantMessage = ({ cell }: { cell: parser_pb.Cell }) => {
  return (
    <MessageContainer role={parser_pb.CellRole.ASSISTANT} kind={cell.kind}>
      <ErrorBoundary suppressHydrationErrors={true} logErrors={true}>
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
      </ErrorBoundary>
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
  switch (cell.kind) {
    case parser_pb.CellKind.CODE:
      return (
        <CodeMessage
          key={cell.refId}
          cell={cell}
          isRecentCodeCell={isRecentCodeCell}
        />
      )
    case parser_pb.CellKind.TOOL:
      return <ToolMessage key={cell.refId} cell={cell} />
    default:
      break
  }

  const mdDivider = '---'
  switch (cell.role) {
    case parser_pb.CellRole.USER:
      return <UserMessage cell={cell} />
    case parser_pb.CellRole.ASSISTANT:
      return <AssistantMessage cell={cell} />
    default:
      if (cell.value !== mdDivider) {
        return <AssistantMessage cell={cell} />
      }
      return null
  }
}

const ChatMessages = ({
  scrollToLatest = true,
}: {
  scrollToLatest?: boolean
}) => {
  const { useColumns, isTyping } = useCell()
  const { settings } = useSettings()
  const { chat } = useColumns()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!scrollToLatest) {
      return
    }
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

const ChatInput = ({ placeholder }: { placeholder?: string }) => {
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
          placeholder={placeholder || 'Enter your question'}
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

const getToolMessageLabeling = (cell: parser_pb.Cell) => {
  const toolName = cell.value
  const isActive = !cell.executionSummary?.success

  const progressIcon = isActive ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 15 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="animate-spin"
    >
      <path
        d="M7.5 1.5C4.5 1.5 2 4 2 7C2 8.9 3 10.5 4.5 11.5L4 12.5C2 11.5 1 9.2 1 7C1 3.5 4 0.5 7.5 0.5C11 0.5 14 3.5 14 7C14 9.2 13 11.5 11 12.5L10.5 11.5C12 10.5 13 8.9 13 7C13 4 10.5 1.5 7.5 1.5Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  ) : (
    <svg
      width="12"
      height="12"
      viewBox="0 0 15 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M11.4669 3.72684C11.7558 3.91574 11.8369 4.30308 11.648 4.59198L7.39799 11.092C7.29783 11.2452 7.13556 11.3467 6.95402 11.3699C6.77247 11.3931 6.58989 11.3355 6.45446 11.2124L3.70446 8.71241C3.44905 8.48022 3.43023 8.08494 3.66242 7.82953C3.89461 7.57412 4.28989 7.55529 4.5453 7.78749L6.75292 9.79441L10.6018 3.90792C10.7907 3.61902 11.178 3.53795 11.4669 3.72684Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )

  let toolLabel = toolName
  let toolIcon
  switch (toolName) {
    case 'code':
    case 'shell':
      toolLabel = 'Code Generation'
      toolIcon = (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="16 18 22 12 16 6"></polyline>
          <polyline points="8 6 2 12 8 18"></polyline>
        </svg>
      )
      break
    case 'file_search':
      toolLabel = 'Searching'
      toolIcon = (
        <svg
          width="16"
          height="16"
          viewBox="0 0 15 15"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle
            cx="6.5"
            cy="6.5"
            r="4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
          <line
            x1="10"
            y1="10"
            x2="13.5"
            y2="13.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )
      break
    default:
      toolIcon = (
        <svg
          width="16"
          height="16"
          viewBox="0 0 15 15"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12.5 2.5L2.5 12.5M2.5 2.5L12.5 12.5M7.5 1.5L7.5 3.5M7.5 11.5L7.5 13.5M1.5 7.5L3.5 7.5M11.5 7.5L13.5 7.5M10.5 4.5L12.5 2.5M4.5 10.5L2.5 12.5M4.5 4.5L2.5 2.5M10.5 10.5L12.5 12.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7.5 1.5C7.5 1.5 7.5 3.5 7.5 3.5M7.5 11.5C7.5 11.5 7.5 13.5 7.5 13.5M1.5 7.5C1.5 7.5 3.5 7.5 3.5 7.5M11.5 7.5C11.5 7.5 13.5 7.5 13.5 7.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )
  }

  return { progressIcon, toolIcon, toolLabel }
}

const textDecoder = new TextDecoder()
const ToolMessage = ({ cell }: { cell: parser_pb.Cell }) => {
  const downloadMessages = useMemo(() => {
    return cell.outputs.map((output) => {
      return output.items.map((i) => {
        const blob = new Blob([textDecoder.decode(i.data)], { type: i.mime })
        const objectUrl = URL.createObjectURL(blob)
        const downloadName = `Demo-${new Date().toISOString()}.md`
        return (
          <MessageContainer
            role={parser_pb.CellRole.ASSISTANT}
            kind={parser_pb.CellKind.MARKUP}
          >
            Docs ready to download at{' '}
            <a href={objectUrl} download={downloadName} className="underline">
              {downloadName}
            </a>
          </MessageContainer>
        )
      })
    })
  }, [cell.outputs])
  const { progressIcon, toolIcon, toolLabel } = getToolMessageLabeling(cell)
  return (
    <>
      {downloadMessages}
      <MessageContainer role={cell.role} kind={cell.kind}>
        <div className="flex items-center gap-2">
          {toolIcon}
          <span className="text-sm font-medium">{toolLabel}</span>
          {progressIcon}
        </div>
      </MessageContainer>
    </>
  )
}

export function ChatSequence() {
  const { useColumns } = useCell()
  const { all } = useColumns()

  const placeholder =
    all.length > 0 ? "What's next?" : 'What problem brings you here today?'
  return (
    <div>
      {/* <ScrollArea type="auto" scrollbars="vertical" className="p-0 w-full"> */}
      <Messages />
      <ChatInput placeholder={placeholder} />
      {/* </ScrollArea> */}
    </div>
  )
}

const Messages = () => {
  const { useColumns, isTyping } = useCell()
  const { settings } = useSettings()
  const { all } = useColumns()

  // const recentIndex = settings.webApp.invertedOrder ? 0 : all.length - 1

  const typingJustification = 'justify-start'

  const typingCell = (
    <div className={`flex ${typingJustification} items-center h-full`}>
      <Message cell={TypingCell} />
    </div>
  )

  return (
    <div className="overflow-y-clip p-1 flex flex-col whitespace-pre-wrap">
      {isTyping && settings.webApp.invertedOrder && typingCell}
      {all.map((cell: parser_pb.Cell) => {
        switch (cell.kind) {
          case parser_pb.CellKind.CODE:
            return <Action key={cell.refId} cell={cell} />
          case parser_pb.CellKind.TOOL:
            return <ToolMessage key={cell.refId} cell={cell} />
          default:
            break
        }
        switch (cell.role) {
          case parser_pb.CellRole.USER:
            return <UserMessage key={cell.refId} cell={cell} />
          case parser_pb.CellRole.ASSISTANT:
            return <AssistantMessage key={cell.refId} cell={cell} />
          default:
            return null
        }
      })}
      {isTyping && !settings.webApp.invertedOrder && typingCell}
    </div>
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
    <div ref={outerDivRef} className="flex flex-col h-full w-full">
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

export { TypingCell }
