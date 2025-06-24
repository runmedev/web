import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Box, Button, Card, ScrollArea, Text } from '@radix-ui/themes'

import { Block, BlockOutputKind, useBlock } from '../../contexts/BlockContext'
import { useSettings } from '../../contexts/SettingsContext'
import { Console, genRunID } from '@runmedev/react-console'
import Editor from './Editor'
import {
  ErrorIcon,
  PlayIcon,
  PlusIcon,
  SpinnerIcon,
  SuccessIcon,
} from './icons'

import '@runmedev/react-console/react-console.css'
import { getSessionToken } from '../../token'

const fontSize = 14
const fontFamily = 'monospace'

function RunActionButton({
  pid,
  exitCode,
  onClick,
}: {
  pid: number | null
  exitCode: number | null
  onClick: () => void
}) {
  return (
    <Button variant="soft" onClick={onClick}>
      {exitCode === null && pid === null && <PlayIcon />}
      {exitCode === null && pid !== null && (
        <div className="animate-spin">
          <SpinnerIcon />
        </div>
      )}
      {exitCode !== null && exitCode === 0 && <SuccessIcon />}
      {exitCode !== null && exitCode > 0 && <ErrorIcon exitCode={exitCode} />}
    </Button>
  )
}

const CodeConsole = memo(
  ({
    blockID,
    runID,
    sequence,
    value,
    settings = {},
    onStdout,
    onStderr,
    onExitCode,
    onPid,
    onMimeType,
  }: {
    blockID: string
    runID: string
    sequence: number
    value: string
    settings?: {
      className?: string
      rows?: number
      fontSize?: number
      fontFamily?: string
      takeFocus?: boolean
      scrollToFit?: boolean
    }
    onStdout: (data: Uint8Array) => void
    onStderr: (data: Uint8Array) => void
    onExitCode: (code: number) => void
    onPid: (pid: number) => void
    onMimeType: (mimeType: string) => void
  }) => {
    const { webApp } = useSettings().settings
    return (
      value != '' &&
      runID != '' && (
        <Console
          blockID={blockID}
          runID={runID}
          sequence={sequence}
          commands={value.split('\n')}
          runner={{
            endpoint: webApp.runner,
            reconnect: webApp.reconnect,
            authorization: {
              bearerToken: getSessionToken(),
            },
          }}
          settings={settings}
          onPid={onPid}
          onStdout={onStdout}
          onStderr={onStderr}
          onExitCode={onExitCode}
          onMimeType={onMimeType}
        />
      )
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.blockID === nextProps.blockID &&
      JSON.stringify(prevProps.value) === JSON.stringify(nextProps.value) &&
      prevProps.runID === nextProps.runID
    )
  }
)

// Action is an editor and an optional Runme console
function Action({ block }: { block: Block }) {
  const { settings } = useSettings()
  const invertedOrder = settings.webApp.invertedOrder
  const { createOutputBlock, sendOutputBlock, incrementSequence, sequence } =
    useBlock()
  const [editorValue, setEditorValue] = useState(block.contents)
  const [takeFocus, setTakeFocus] = useState(false)
  const [exec, setExec] = useState<{ value: string; runID: string }>({
    value: '',
    runID: '',
  })
  const [pid, setPid] = useState<number | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [mimeType, setMimeType] = useState<string | null>(null)
  const [stdout, setStdout] = useState<string>('')
  const [stderr, setStderr] = useState<string>('')
  const [lastRunID, setLastRunID] = useState<string>('')
  const [lastSequence, setLastSequence] = useState<number | null>(null)

  const runCode = useCallback(
    (takeFocus = false) => {
      setStdout('')
      setStderr('')
      setPid(null)
      setExitCode(null)
      setTakeFocus(takeFocus)
      incrementSequence()
      setExec({ value: editorValue, runID: genRunID() })
    },
    [editorValue, incrementSequence]
  )

  // Listen for runCodeBlock events
  useEffect(() => {
    const handleRunCodeBlock = (event: CustomEvent) => {
      if (event.detail.blockId === block.id) {
        runCode()
      }
    }

    window.addEventListener('runCodeBlock', handleRunCodeBlock as EventListener)
    return () => {
      window.removeEventListener(
        'runCodeBlock',
        handleRunCodeBlock as EventListener
      )
    }
  }, [block.id, runCode])

  const finalOutputBlock = useMemo(() => {
    if (
      pid === null ||
      exitCode === null ||
      exec.runID === '' ||
      !Number.isFinite(pid) ||
      !Number.isInteger(exitCode)
    ) {
      return null
    }

    const outputBlock = createOutputBlock({
      ...block,
      outputs: [
        {
          $typeName: 'BlockOutput',
          kind: BlockOutputKind.STDOUT,
          items: [
            {
              $typeName: 'BlockOutputItem',
              mime: mimeType || 'text/plain',
              textData: stdout,
            },
          ],
        },
        {
          $typeName: 'BlockOutput',
          kind: BlockOutputKind.STDERR,
          items: [
            {
              $typeName: 'BlockOutputItem',
              mime: mimeType || 'text/plain',
              textData: stderr,
            },
          ],
        },
      ],
    })

    return outputBlock
  }, [
    block,
    createOutputBlock,
    stdout,
    stderr,
    mimeType,
    pid,
    exitCode,
    exec.runID,
  ])

  useEffect(() => {
    // avoid infinite loop
    if (!finalOutputBlock || lastRunID === exec.runID) {
      return
    }

    setLastRunID(exec.runID)
    sendOutputBlock(finalOutputBlock)
  }, [sendOutputBlock, finalOutputBlock, exec.runID, lastRunID])

  useEffect(() => {
    if (lastRunID === exec.runID) {
      return
    }
    setLastSequence(sequence)
  }, [sequence, exec.runID, lastRunID])

  useEffect(() => {
    setEditorValue(block.contents)
  }, [block.contents])

  const sequenceLabel = useMemo(() => {
    if (!lastSequence) {
      return ' '
    }
    return lastSequence.toString()
  }, [lastSequence])

  return (
    <div>
      <Box className="w-full p-2">
        <div className="flex justify-between items-top">
          <div className="flex flex-col items-center">
            <RunActionButton
              pid={pid}
              exitCode={exitCode}
              onClick={() => {
                runCode(true)
              }}
            />
            <Text
              size="2"
              className="mt-1 p-2 font-bold text-gray-400 font-mono"
            >
              [{sequenceLabel}]
            </Text>
          </div>
          <Card className="whitespace-nowrap overflow-hidden flex-1 ml-2">
            <Editor
              key={block.id}
              id={block.id}
              value={editorValue}
              fontSize={fontSize}
              fontFamily={fontFamily}
              onChange={(v) => {
                setPid(null)
                setExitCode(null)
                setEditorValue(v)
              }}
              onEnter={() => runCode()}
            />
            <CodeConsole
              key={exec.runID}
              runID={exec.runID}
              blockID={block.id}
              sequence={lastSequence || 0}
              value={exec.value}
              settings={{
                takeFocus: takeFocus,
                scrollToFit: !invertedOrder,
                className: 'rounded-md overflow-hidden',
                rows: 14,
                fontSize,
                fontFamily,
              }}
              onStdout={(data: Uint8Array) =>
                setStdout((prev) => prev + new TextDecoder().decode(data))
              }
              onStderr={(data: Uint8Array) =>
                setStderr((prev) => prev + new TextDecoder().decode(data))
              }
              onPid={setPid}
              onExitCode={setExitCode}
              onMimeType={setMimeType}
            />
          </Card>
        </div>
      </Box>
    </div>
  )
}

function Actions() {
  const { useColumns, addCodeBlock } = useBlock()
  const { settings } = useSettings()
  const { actions } = useColumns()
  const actionsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (settings.webApp.invertedOrder) return
    actionsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [actions, settings.webApp.invertedOrder])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center mb-2">
        <Text size="5" weight="bold" className="pr-2">
          Actions
        </Text>
        <Button
          variant="ghost"
          size="1"
          className="cursor-pointer"
          onClick={addCodeBlock}
        >
          <PlusIcon />
        </Button>
      </div>
      <ScrollArea type="auto" scrollbars="vertical" className="flex-1 p-2">
        {actions.map((action) => (
          <Action key={action.id} block={action} />
        ))}
        <div ref={actionsEndRef} />
      </ScrollArea>
    </div>
  )
}

export default Actions
