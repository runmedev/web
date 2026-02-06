 
import { useEffect, useMemo, useRef } from 'react'

import { Interceptor } from '@connectrpc/connect'
import '@runmedev/renderers'
import type { RunmeConsoleStream, ConsoleViewConfig } from '@runmedev/renderers'

interface ConsoleSettings {
  rows?: number
  className?: string
  fontSize?: number
  fontFamily?: string
  takeFocus?: boolean
  scrollToFit?: boolean
}

interface ConsoleRunner {
  endpoint: string
  reconnect: boolean
  interceptors: Interceptor[]
}

export interface ConsoleProps {
  cellID: string
  runID: string
  sequence: number
  languageID?: string
  commands: string[]
  content?: string
  runner: ConsoleRunner
  settings?: ConsoleSettings
  onStdout?: (data: Uint8Array) => void
  onStderr?: (data: Uint8Array) => void
  onExitCode?: (code: number) => void
  onPid?: (pid: number) => void
  onMimeType?: (mimeType: string) => void
}

function Console({
  cellID,
  runID,
  sequence,
  languageID,
  commands,
  content,
  runner,
  settings: settingsProp = {},
  onStdout,
  onStderr,
  onExitCode,
  onPid,
  onMimeType,
}: ConsoleProps) {
  const {
    rows = 20,
    className,
    fontSize = 12,
    fontFamily = 'monospace',
    takeFocus = true,
    scrollToFit = true,
  } = settingsProp

  const elemRef = useRef<any>(null)

  const webComponentDefaults: {
    id: string
    takeFocus: boolean
    initialContent: string
    initialRows: number
    view: ConsoleViewConfig
  } = useMemo(
    () => ({
      id: cellID,
      takeFocus,
      initialContent: content || '',
      initialRows: rows,
      view: {
        theme: 'dark',
        fontFamily: fontFamily || 'monospace',
        fontSize: fontSize || 12,
        cursorStyle: 'block',
        cursorBlink: true,
        cursorWidth: 1,
        smoothScrollDuration: 0,
        scrollback: 4000,
      },
    }),
    [cellID, fontFamily, fontSize, takeFocus, scrollToFit, rows, content]
  )

  const webComponentStream: RunmeConsoleStream = useMemo(
    () => ({
      knownID: cellID,
      runID,
      sequence,
      languageID,
      runnerEndpoint: runner.endpoint,
      reconnect: runner.reconnect,
    }),
    [cellID, runID, sequence, languageID, runner.endpoint, runner.reconnect]
  )

  // Set up event listeners when the console element is available and callbacks change
  useEffect(() => {
    const el = elemRef.current
    if (!el) {
      return
    }
    const onStdoutHandler = (e: CustomEvent) => onStdout?.(e.detail)
    const onStderrHandler = (e: CustomEvent) => onStderr?.(e.detail)
    const onExitHandler = (e: CustomEvent) => onExitCode?.(e.detail)
    const onPidHandler = (e: CustomEvent) => onPid?.(e.detail)
    const onMimeHandler = (e: CustomEvent) => onMimeType?.(e.detail)
    el.addEventListener('stdout', onStdoutHandler)
    el.addEventListener('stderr', onStderrHandler)
    el.addEventListener('exitcode', onExitHandler)
    el.addEventListener('pid', onPidHandler)
    el.addEventListener('mimetype', onMimeHandler)
    return () => {
      el.removeEventListener('stdout', onStdoutHandler)
      el.removeEventListener('stderr', onStderrHandler)
      el.removeEventListener('exitcode', onExitHandler)
      el.removeEventListener('pid', onPidHandler)
      el.removeEventListener('mimetype', onMimeHandler)
    }
  }, [onStdout, onStderr, onExitCode, onPid, onMimeType])

  return (
    <div
      className={className}
      ref={(el) => {
        if (!el || el.hasChildNodes()) {
          return
        }
        const elem = document.createElement('runme-console') as any
        elemRef.current = elem

        elem.setAttribute('id', webComponentDefaults.id)

        if (typeof webComponentDefaults.takeFocus === 'boolean') {
          elem.setAttribute(
            'takeFocus',
            webComponentDefaults.takeFocus ? 'true' : 'false'
          )
        }

        if (webComponentDefaults.view) {
          elem.setAttribute('view', JSON.stringify(webComponentDefaults.view))
        }

        if (webComponentDefaults.initialRows !== undefined) {
          elem.setAttribute(
            'initialRows',
            webComponentDefaults.initialRows.toString()
          )
        }

        if (webComponentDefaults.initialContent !== undefined) {
          elem.setAttribute(
            'initialContent',
            webComponentDefaults.initialContent
          )
        }

        // If runID is set it means the cell needs execution, pass through execution/session config
        if (webComponentStream.runID) {
          elem.setAttribute('stream', JSON.stringify(webComponentStream))
        }

        // Bypass attributes because serialization of funcs won't work
        elem.interceptors = runner.interceptors
        elem.commands = commands

        el.appendChild(elem)
        const terminalEnd = document.createElement('div')
        terminalEnd.setAttribute('className', 'h-1')
        el.appendChild(terminalEnd)

        setTimeout(() => {
          if (scrollToFit && !isInViewport(terminalEnd)) {
            terminalEnd.scrollIntoView({ behavior: 'smooth' })
          }
        }, 0)
      }}
    ></div>
  )
}

function isInViewport(element: Element) {
  const rect = element.getBoundingClientRect()
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <=
      (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  )
}

export default Console
