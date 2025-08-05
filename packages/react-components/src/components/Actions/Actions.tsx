import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { create } from '@bufbuild/protobuf'
import { Box, Button, Card, ScrollArea, Text } from '@radix-ui/themes'
import '@runmedev/react-console/react-console.css'

import { parser_pb, useCell } from '../../contexts/CellContext'
import { useOutput } from '../../contexts/OutputContext'
import { useSettings } from '../../contexts/SettingsContext'
import { MimeType, RunmeMetadataKey } from '../../runme/client'
import CellConsole, { fontSettings } from './CellConsole'
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
    <div>
      <Box className="w-full p-2">
        <div className="flex justify-between items-top">
          <div className="flex flex-col items-center">
            <RunActionButton pid={pid} exitCode={exitCode} onClick={runCode} />
            <Text
              size="2"
              className="mt-1 p-2 font-bold text-gray-400 font-mono"
              data-testid="sequence-label"
            >
              [{sequenceLabel}]
            </Text>
          </div>
          <Card className="whitespace-nowrap overflow-hidden flex-1 ml-2">
            <Editor
              key={`editor-${cell.refId}`}
              id={cell.refId}
              value={cell.value}
              language="shellscript"
              fontSize={fontSettings.fontSize}
              fontFamily={fontSettings.fontFamily}
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

function Actions() {
  const { useColumns, addCodeCell } = useCell()
  const { settings } = useSettings()
  const { actions } = useColumns()
  const actionsStartRef = useRef<HTMLDivElement>(null)
  const actionsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (settings.webApp.invertedOrder) {
      actionsStartRef.current?.scrollIntoView({ behavior: 'smooth' })
      return
    }
    actionsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [actions, settings.webApp.invertedOrder])

  const { registerRenderer, unregisterRenderer } = useOutput()

  // Register renderers, e.g. a terminal for shell-ish cells
  useEffect(() => {
    registerRenderer(MimeType.StatefulRunmeTerminal, {
      onCellUpdate: (cell: parser_pb.Cell) => {
        if (!cell.languageId.endsWith('sh') && cell.languageId !== '') {
          return
        }

        if (cell.kind !== parser_pb.CellKind.CODE || cell.outputs.length > 0) {
          return
        }

        // it's basically shell, be prepared to render a terminal
        cell.outputs = [
          create(parser_pb.CellOutputSchema, {
            items: [
              create(parser_pb.CellOutputItemSchema, {
                mime: MimeType.StatefulRunmeTerminal,
                type: 'Buffer',
                data: new Uint8Array(), // todo(sebastian): pass terminal settings
              }),
            ],
          }),
        ]
      },
      component: ({
        cell,
        onPid,
        onExitCode,
      }: {
        cell: parser_pb.Cell
        onPid: (pid: number | null) => void
        onExitCode: (exitCode: number | null) => void
      }) => {
        return (
          <CellConsole
            key={`console-${cell.refId}`}
            cell={cell}
            onPid={onPid}
            onExitCode={onExitCode}
          />
        )
      },
    })

    return () => {
      unregisterRenderer(MimeType.StatefulRunmeTerminal)
    }
  }, [registerRenderer, unregisterRenderer])

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
          onClick={addCodeCell}
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
