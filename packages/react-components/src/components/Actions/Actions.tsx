import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Box, Button, Card, ScrollArea, Text } from '@radix-ui/themes'

// import '@runmedev/react-console/react-console-light.css'

import { parser_pb, useCell } from '../../contexts/CellContext'
import { useOutput } from '../../contexts/OutputContext'
import { useSettings } from '../../contexts/SettingsContext'
import { RunmeMetadataKey } from '../../runme/client'
import { fontSettings } from './CellConsole'
import Editor from './Editor'
import {
  ErrorIcon,
  PlayIcon,
  PlusIcon,
  SpinnerIcon,
  SuccessIcon,
} from './icons'

function RunActionButton({
  pid,
  exitCode,
  onClick,
}: {
  pid: number | null
  exitCode: number | null
  onClick: () => void
}) {
  const getButtonLabel = () => {
    if (exitCode === null && pid === null) {
      return 'Run code'
    }
    if (exitCode === null && pid !== null) {
      return 'Running...'
    }
    if (exitCode !== null && exitCode === 0) {
      return 'Execution successful'
    }
    if (exitCode !== null && exitCode > 0) {
      return `Execution failed with exit code ${exitCode}`
    }
    return 'Run code'
  }

  return (
    <Button variant="soft" onClick={onClick} aria-label={getButtonLabel()}>
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

// Action is an editor and an optional Runme console
function Action({ cell }: { cell: parser_pb.Cell }) {
  const { saveState, runCodeCell } = useCell()
  const { getRenderer } = useOutput()

  const [pid, setPid] = useState<number | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)

  const runCode = useCallback(() => {
    runCodeCell(cell)
  }, [cell, runCodeCell])

  const sequenceLabel = useMemo(() => {
    const seq = Number(cell.metadata[RunmeMetadataKey.Sequence])
    if (!seq) {
      return ' '
    }
    return seq.toString()
  }, [cell, pid, exitCode])

  return (
    <div className="w-full min-w-0">
      <Box className="w-full p-2">
        <div className="flex justify-between items-start gap-2 w-full">
          <div className="flex flex-col items-center flex-shrink-0">
            <RunActionButton pid={pid} exitCode={exitCode} onClick={runCode} />
            <Text
              size="2"
              className="mt-1 p-2 font-bold text-gray-400 font-mono"
              data-testid="sequence-label"
            >
              [{sequenceLabel}]
            </Text>
          </div>
          <Card className="flex-1 ml-2 min-w-0">
            <Editor
              key={`editor-${cell.refId}`}
              id={cell.refId}
              value={cell.value}
              language={cell.languageId}
              fontSize={fontSettings.fontSize}
              fontFamily={fontSettings.fontFamily}
              showLanguageSelector={true}
              onChange={(v) => {
                cell.value = v // only sync cell value on change
                saveState()
              }}
              onEnter={runCode}
            />
            {cell.outputs.flatMap((o) =>
              (o.items ?? []).map((oi) => {
                const renderer = getRenderer(oi.mime)
                if (!renderer) {
                  return null
                }
                const Component = renderer.component
                return (
                  <Component
                    key={`${oi.mime}-${cell.refId}`}
                    cell={cell}
                    onPid={setPid}
                    onExitCode={setExitCode}
                    {...renderer.props}
                  />
                )
              })
            )}
          </Card>
        </div>
      </Box>
    </div>
  )
}

function Actions({
  headline,
  scrollToLatest = true,
}: {
  headline?: string
  scrollToLatest?: boolean
}) {
  const { useColumns, addCodeCell } = useCell()
  const { settings } = useSettings()
  const { actions } = useColumns()
  const actionsStartRef = useRef<HTMLDivElement>(null)
  const actionsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!scrollToLatest) {
      return
    }
    if (settings.webApp.invertedOrder) {
      actionsStartRef.current?.scrollIntoView({ behavior: 'smooth' })
      return
    }
    actionsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [actions, settings.webApp.invertedOrder])

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center mb-2">
        {headline && (
          <Text size="5" weight="bold" className="pr-2">
            {headline}
          </Text>
        )}
        <Button
          variant="ghost"
          size="1"
          className="cursor-pointer"
          onClick={() => addCodeCell({ languageId: 'sh' })}
          aria-label="Add code cell"
        >
          <PlusIcon />
        </Button>
      </div>
      <ScrollArea type="auto" scrollbars="vertical" className="flex-1 p-2">
        <div ref={actionsStartRef} />
        {actions.map((actionCell) => (
          <Action key={`action-${actionCell.refId}`} cell={actionCell} />
        ))}
        <div ref={actionsEndRef} />
      </ScrollArea>
    </div>
  )
}

export { Action }
export default Actions
