import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { create } from '@bufbuild/protobuf'
import { Box, Button, Card, ScrollArea, Text } from '@radix-ui/themes'
import { genRunID } from '@runmedev/react-console'
import '@runmedev/react-console/react-console.css'

import {
  MimeType,
  createCellOutputs,
  parser_pb,
  useCell,
} from '../../contexts/CellContext'
import { useSettings } from '../../contexts/SettingsContext'
import { RunmeMetadataKey } from '../../runme/client'
import CellConsole from './CellConsole'
import Editor from './Editor'
import {
  ErrorIcon,
  PlayIcon,
  PlusIcon,
  SpinnerIcon,
  SuccessIcon,
} from './icons'

const fontSize = 14
const fontFamily = 'monospace'
const textDecoder = new TextDecoder()

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

// Action is an editor and an optional Runme console
function Action({ cell }: { cell: parser_pb.Cell }) {
  const { settings } = useSettings()
  const invertedOrder = settings.webApp.invertedOrder
  const { sendOutputCell, saveState, incrementSequence, sequence } = useCell()
  const [editorValue, setEditorValue] = useState(cell.value)
  const [takeFocus, setTakeFocus] = useState(false)
  const [exec, setExec] = useState<{ value: string; runID: string }>({
    value: '',
    runID: '',
  })
  const [pid, setPid] = useState<number | null>(null)
  const [startTime, setStartTime] = useState<bigint | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [mimeType, setMimeType] = useState<string | null>(null)
  const [stdout, setStdout] = useState<string>('')
  const [stderr, setStderr] = useState<string>('')
  const [lastRunID, setLastRunID] = useState<string>('')
  const [lastSequence, setLastSequence] = useState<number | null>(null)

  const runCode = useCallback(
    (takeFocus = false) => {
      setStartTime(BigInt(Date.now()))
      cell.executionSummary = undefined
      cell.outputs = []
      setStdout('')
      setStderr('')
      setPid(null)
      setExitCode(null)
      setTakeFocus(takeFocus)
      incrementSequence()
      setExec({ value: editorValue, runID: genRunID() })
    },
    [cell, editorValue, incrementSequence]
  )

  // Listen for runCodeCell events
  useEffect(() => {
    const handleRunCodeCell = (event: CustomEvent) => {
      if (event.detail.cellId === cell.refId) {
        runCode()
      }
    }

    window.addEventListener('runCodeCell', handleRunCodeCell as EventListener)
    return () => {
      window.removeEventListener(
        'runCodeCell',
        handleRunCodeCell as EventListener
      )
    }
  }, [cell.refId, runCode])

  const cellOutputs = useMemo(() => {
    return createCellOutputs({ pid, exitCode }, stdout, stderr, mimeType)
  }, [pid, exitCode, stdout, stderr, mimeType])

  useEffect(() => {
    if (startTime === null) {
      return
    }

    cell.outputs = cellOutputs
    cell.executionSummary = create(parser_pb.CellExecutionSummarySchema, {
      timing: create(parser_pb.ExecutionSummaryTimingSchema, {
        startTime: startTime,
        endTime: BigInt(Date.now()),
      }),
      executionOrder: sequence,
      success: Number.isFinite(exitCode) && exitCode === 0,
    })
  }, [cell, cellOutputs, exitCode, sequence, startTime])

  const finalOutputCell = useMemo(() => {
    if (
      pid === null ||
      exitCode === null ||
      exec.runID === '' ||
      !Number.isFinite(pid) ||
      !Number.isInteger(exitCode)
    ) {
      return null
    }

    return cell
  }, [cell, exec.runID, exitCode, pid])

  useEffect(() => {
    // avoid infinite loop
    if (!finalOutputCell || lastRunID === exec.runID) {
      return
    }

    setLastRunID(exec.runID)
    sendOutputCell(finalOutputCell)
  }, [sendOutputCell, finalOutputCell, exec.runID, lastRunID])

  useEffect(() => {
    if (lastRunID === exec.runID) {
      return
    }
    setLastSequence(sequence)
  }, [sequence, exec.runID, lastRunID])

  useEffect(() => {
    setEditorValue(cell.value)
  }, [cell.value])

  useEffect(() => {
    // Only save metadata for code cells
    if (cell.kind !== parser_pb.CellKind.CODE) {
      return
    }

    // cells with lastRunID might still be running
    // never delete lastRunID, only overwrite it
    if (exec.runID !== '') {
      cell.metadata[RunmeMetadataKey.LastRunID] = exec.runID
    }

    // cell with PIDs are running
    if (pid) {
      cell.metadata[RunmeMetadataKey.Pid] = pid.toString()
    } else {
      delete cell.metadata[RunmeMetadataKey.Pid]
    }

    // cell with exit codes are done running, remove PID
    if (exitCode !== null && Number.isFinite(exitCode)) {
      delete cell.metadata[RunmeMetadataKey.Pid]
      cell.metadata[RunmeMetadataKey.ExitCode] = exitCode.toString()
    } else {
      delete cell.metadata[RunmeMetadataKey.ExitCode]
    }

    // cells with neither PID nor exit code never ran
    // always save the state changes, if we have cells
    saveState()
  }, [pid, exitCode, cell, saveState, exec.runID])

  const content = useMemo(() => {
    if (cell.kind !== parser_pb.CellKind.CODE) {
      return undefined
    }

    if (lastRunID !== '') {
      return undefined
    }

    const stdoutItem = cell.outputs
      .flatMap((output) => output.items)
      .find((item) => item.mime === MimeType.VSCodeNotebookStdOut)

    if (!stdoutItem) {
      return undefined
    }

    return textDecoder.decode(stdoutItem.data)
  }, [cell.kind, cell.outputs, lastRunID])

  // If the cell has an exit code but no PID, return the last run ID
  // This will attempt to resume execution of the cell from the last run
  const recoveredRunID = useMemo(() => {
    const rePid = cell.metadata[RunmeMetadataKey.Pid] ?? ''

    if (!rePid) {
      return ''
    }

    return cell.metadata[RunmeMetadataKey.LastRunID] ?? ''
  }, [cell.metadata])

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
              key={cell.refId}
              id={cell.refId}
              value={editorValue}
              language="shellscript"
              fontSize={fontSize}
              fontFamily={fontFamily}
              onChange={(v) => {
                setPid(null)
                setExitCode(null)
                setEditorValue(v)
                cell.value = v // only sync cell value on change
                saveState()
              }}
              onEnter={() => runCode()}
            />
            <CellConsole
              key={exec.runID}
              runID={exec.runID || recoveredRunID}
              cellID={cell.refId}
              sequence={lastSequence || 0}
              value={exec.value}
              content={content}
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
        >
          <PlusIcon />
        </Button>
      </div>
      <ScrollArea type="auto" scrollbars="vertical" className="flex-1 p-2">
        <div ref={actionsStartRef} />
        {actions.map((action) => (
          <Action key={action.refId} cell={action} />
        ))}
        <div ref={actionsEndRef} />
      </ScrollArea>
    </div>
  )
}

export default Actions
