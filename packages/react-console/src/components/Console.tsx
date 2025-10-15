/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo } from 'react'

import { Interceptor } from '@connectrpc/connect'
import '@runmedev/renderers'

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
}: {
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
}) {
  const {
    rows = 20,
    className,
    fontSize = 12,
    fontFamily = 'monospace',
    takeFocus = true,
    scrollToFit = true,
  } = settingsProp

  const webComponentDefaults = useMemo(
    () => ({
      output: {
        'runme.dev/id': cellID,
        theme: 'dark',
        fontFamily: fontFamily || 'monospace',
        fontSize: fontSize || 12,
        cursorStyle: 'block',
        cursorBlink: true,
        cursorWidth: 1,
        takeFocus,
        scrollToFit,
        smoothScrollDuration: 0,
        scrollback: 4000,
        initialRows: rows,
        content: content || '',
        isAutoSaveEnabled: false,
        isPlatformAuthEnabled: false,
      },
    }),
    [cellID, fontFamily, fontSize, takeFocus, scrollToFit, rows, content]
  )

  useEffect(() => {
    // Wire custom events from web component to React callbacks
    const el = document.querySelector(`console-view[id="${cellID}"]`) as any
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
        const consoleEl = document.createElement('console-view') as any
        consoleEl.setAttribute('buttons', 'false')

        consoleEl.setAttribute(
          'id',
          webComponentDefaults.output['runme.dev/id']!
        )
        consoleEl.setAttribute('theme', webComponentDefaults.output.theme)
        consoleEl.setAttribute(
          'fontFamily',
          webComponentDefaults.output.fontFamily
        )
        if (typeof webComponentDefaults.output.fontSize === 'number') {
          consoleEl.setAttribute(
            'fontSize',
            webComponentDefaults.output.fontSize.toString()
          )
        }
        if (webComponentDefaults.output.cursorStyle) {
          consoleEl.setAttribute(
            'cursorStyle',
            webComponentDefaults.output.cursorStyle
          )
        }
        if (typeof webComponentDefaults.output.cursorBlink === 'boolean') {
          consoleEl.setAttribute(
            'cursorBlink',
            webComponentDefaults.output.cursorBlink ? 'true' : 'false'
          )
        }
        if (typeof webComponentDefaults.output.cursorWidth === 'number') {
          consoleEl.setAttribute(
            'cursorWidth',
            webComponentDefaults.output.cursorWidth.toString()
          )
        }

        if (typeof webComponentDefaults.output.takeFocus === 'boolean') {
          consoleEl.setAttribute(
            'takeFocus',
            webComponentDefaults.output.takeFocus ? 'true' : 'false'
          )
        }

        if (
          typeof webComponentDefaults.output.smoothScrollDuration === 'number'
        ) {
          consoleEl.setAttribute(
            'smoothScrollDuration',
            webComponentDefaults.output.smoothScrollDuration.toString()
          )
        }

        if (typeof webComponentDefaults.output.scrollback === 'number') {
          consoleEl.setAttribute(
            'scrollback',
            webComponentDefaults.output.scrollback.toString()
          )
        }
        if (webComponentDefaults.output.initialRows !== undefined) {
          consoleEl.setAttribute(
            'initialRows',
            webComponentDefaults.output.initialRows.toString()
          )
        }

        if (webComponentDefaults.output.content !== undefined) {
          consoleEl.setAttribute(
            'initialContent',
            webComponentDefaults.output.content
          )
        }

        if (webComponentDefaults.output.isAutoSaveEnabled) {
          consoleEl.setAttribute(
            'isAutoSaveEnabled',
            webComponentDefaults.output.isAutoSaveEnabled.toString()
          )
        }

        if (webComponentDefaults.output.isPlatformAuthEnabled) {
          consoleEl.setAttribute(
            'isPlatformAuthEnabled',
            webComponentDefaults.output.isPlatformAuthEnabled.toString()
          )
        }

        // Pass-through execution/session config
        consoleEl.setAttribute('knownId', cellID)
        consoleEl.setAttribute('runId', runID)
        consoleEl.setAttribute('sequence', String(sequence))
        if (languageID) {
          consoleEl.setAttribute('languageId', languageID)
        }
        consoleEl.setAttribute('runnerEndpoint', runner.endpoint)
        consoleEl.setAttribute('reconnect', runner.reconnect ? 'true' : 'false')
        consoleEl.interceptors = runner.interceptors
        consoleEl.commands = commands

        el.appendChild(consoleEl)
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
