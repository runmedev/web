import { memo, useCallback, useEffect, useMemo, useState } from 'react'

import { create } from '@bufbuild/protobuf'
import { Console, genRunID } from '@runmedev/react-console'

import { useCell } from '../../contexts'
import {
  MimeType,
  createCellOutputs,
  parser_pb,
} from '../../contexts/CellContext'
import { useSettings } from '../../contexts/SettingsContext'
import { RunmeMetadataKey } from '../../runme/client'

export const fontSettings = {
  fontSize: 14,
  fontFamily: 'monospace',
}

const textDecoder = new TextDecoder()

// Create a memoized Console component to prevent unnecessary re-renders
const MemoizedConsole = memo(Console, (prevProps, nextProps) => {
  return (
    prevProps.cellID === nextProps.cellID && prevProps.runID === nextProps.runID
  )
})

// todo(sebastian): we should turn this into a CellConsole and mold this component to the Cell type
const CellConsole = ({
  cell,
  onExitCode,
  onPid,
}: {
  cell: parser_pb.Cell
  onExitCode: (code: number) => void
  onPid: (pid: number) => void
}) => {
  const {
    createAuthInterceptors,
    settings: { webApp },
  } = useSettings()
  const { sendOutputCell, saveState } = useCell()

  const invertedOrder = webApp.invertedOrder
  const [takeFocus, setTakeFocus] = useState(false)
  const [exec, setExec] = useState<{ value: string; runID: string }>({
    value: '',
    runID: '',
  })
  const [startTime, setStartTime] = useState<bigint | null>(null)
  const [pid, setPid] = useState<number | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [mimeType, setMimeType] = useState<string | null>(null)
  const [stdout, setStdout] = useState<string>('')
  const [stderr, setStderr] = useState<string>('')
  const [lastRunID, setLastRunID] = useState<string>('')

  const sequence = useMemo(() => {
    return Number(cell.metadata[RunmeMetadataKey.Sequence] ?? 0)
  }, [cell, pid, exitCode]) // requires these deps to re-render when seq changes

  const runCode = useCallback(
    (takeFocus = false) => {
      setStartTime(BigInt(Date.now()))
      setStdout('')
      setStderr('')
      setPid(null)
      setExitCode(null)
      setTakeFocus(takeFocus)
      setExec({ value: cell.value, runID: genRunID() })
    },
    [cell]
  )

  const consoleSettings = useMemo(() => {
    return {
      ...fontSettings,
      className: 'rounded-md overflow-hidden',
      rows: 14,
      scrollToFit: !invertedOrder,
      takeFocus,
    }
  }, [invertedOrder, takeFocus])

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
    if (pid !== null) {
      onPid(pid)
    }
  }, [pid, onPid])

  useEffect(() => {
    if (exitCode !== null) {
      onExitCode(exitCode)
    }
  }, [exitCode, onExitCode])

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
    const rePid = cell.metadata?.[RunmeMetadataKey.Pid] ?? ''

    if (!rePid) {
      return ''
    }

    return cell.metadata[RunmeMetadataKey.LastRunID] ?? ''
  }, [cell.metadata])

  const commands = useMemo(() => {
    if (exec.value === '' || exec.runID === '') {
      return []
    }

    return exec.value.split('\n')
  }, [exec])

  const runID = useMemo(() => {
    if (exec.runID === '') {
      return recoveredRunID
    }
    return exec.runID
  }, [exec.runID, recoveredRunID])

  // Stabilize the runner object to prevent unnecessary re-renders
  const runner = useMemo(
    () => ({
      endpoint: webApp.runner,
      reconnect: webApp.reconnect,
      interceptors: createAuthInterceptors(false),
    }),
    [webApp.runner, webApp.reconnect, createAuthInterceptors]
  )

  // Stabilize callback functions to prevent unnecessary re-renders
  const handleStdout = useCallback((data: Uint8Array) => {
    setStdout((prev) => prev + new TextDecoder().decode(data))
  }, [])

  const handleStderr = useCallback((data: Uint8Array) => {
    setStderr((prev) => prev + new TextDecoder().decode(data))
  }, [])

  // Stabilize state setters (these are already stable from useState, but making it explicit)
  const handlePid = useCallback((pid: number) => {
    setPid(pid)
  }, [])

  const handleExitCode = useCallback((code: number) => {
    setExitCode(code)
  }, [])

  const handleMimeType = useCallback((mimeType: string) => {
    setMimeType(mimeType)
  }, [])

  // Early return if no commands or content to display
  if (commands.length === 0 && (!content || content.length === 0)) {
    return null
  }

  return (
    <MemoizedConsole
      key={runID}
      cellID={cell.refId}
      runID={runID}
      sequence={sequence}
      commands={commands}
      content={content}
      runner={runner}
      settings={consoleSettings}
      onPid={handlePid}
      onStdout={handleStdout}
      onStderr={handleStderr}
      onExitCode={handleExitCode}
      onMimeType={handleMimeType}
    />
  )
}

export default CellConsole
