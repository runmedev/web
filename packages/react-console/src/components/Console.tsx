/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo } from 'react'

import { CommandMode } from '@buf/stateful_runme.bufbuild_es/runme/runner/v2/config_pb'
import {
  ExecuteRequestSchema,
  SessionStrategy,
  WinsizeSchema,
} from '@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { create } from '@bufbuild/protobuf'
import { Interceptor } from '@connectrpc/connect'
import { RendererContext } from 'vscode-notebook-renderer'
import { VSCodeEvent } from 'vscode-notebook-renderer/events'

// anything below is required for the webcomponents to work
import '../renderers/client'
// @ts-expect-error because the webcomponents are not typed
import { ClientMessages, setContext } from '../renderers/client'
import '../renderers/runme-vscode.css'
import Streams from '../streams'

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

  const recoveredContent = useMemo(() => {
    if (!cellID || content === '') {
      return null
    }
    return content
  }, [cellID, content])

  const streams = useMemo(() => {
    if (!cellID || !runID || !runner.endpoint) {
      return undefined
    }

    console.log('Creating stream', cellID, runID, runner.endpoint)
    return new Streams({
      knownID: cellID,
      runID,
      sequence,
      options: {
        runnerEndpoint: runner.endpoint,
        interceptors: runner.interceptors,
        autoReconnect: runner.reconnect,
      },
    })
  }, [cellID, runID, sequence, runner])

  useEffect(() => {
    const sub = streams
      ?.connect()
      .subscribe((latency) =>
        console.log(
          `Heartbeat latency for streamID ${latency?.streamID} (${latency?.readyState === 1 ? 'open' : 'closed'}): ${latency?.latency}ms`
        )
      )
    return () => {
      sub?.unsubscribe()
      streams?.close()
    }
  }, [streams])

  let winsize = create(WinsizeSchema, {
    rows: 34,
    cols: 100,
    x: 0,
    y: 0,
  })

  const executeRequest = useMemo(() => {
    return create(ExecuteRequestSchema, {
      sessionStrategy: SessionStrategy.MOST_RECENT, // without this every exec gets its own session
      storeStdoutInEnv: true,
      config: {
        languageId: 'sh',
        background: false,
        fileExtension: '',
        env: [`RUNME_ID=${cellID}`, 'RUNME_RUNNER=v2', 'TERM=xterm-256color'],
        source: {
          case: 'commands',
          value: {
            items: commands,
          },
        },
        interactive: true,
        mode: CommandMode.INLINE,
        runId: runID,
        knownId: cellID,
        // knownName: "the-cell-name",
      },
      winsize,
    })
  }, [cellID, runID, commands, winsize])

  const webComponentDefaults = useMemo(
    () => ({
      output: {
        'runme.dev/id': executeRequest.config?.knownId,
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
        content: recoveredContent || '',
        isAutoSaveEnabled: false,
        isPlatformAuthEnabled: false,
      },
    }),
    [
      executeRequest.config?.knownId,
      fontFamily,
      fontSize,
      takeFocus,
      scrollToFit,
      rows,
      recoveredContent,
    ]
  )

  const encoder = new TextEncoder()

  setContext({
    postMessage: (message: unknown) => {
      if (
        (message as any).type === ClientMessages.terminalOpen ||
        (message as any).type === ClientMessages.terminalResize
      ) {
        const cols = Number((message as any).output.terminalDimensions.columns)
        const rows = Number((message as any).output.terminalDimensions.rows)
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          // If the dimensions are the same, return early
          if (winsize.cols === cols && winsize.rows === rows) {
            return
          }
          winsize = create(WinsizeSchema, {
            cols,
            rows,
            x: 0,
            y: 0,
          })
          const req = create(ExecuteRequestSchema, {
            winsize,
          })
          streams?.sendExecuteRequest(req)
        }
      }

      if ((message as any).type === ClientMessages.terminalStdin) {
        const inputData = encoder.encode((message as any).output.input)
        const req = create(ExecuteRequestSchema, { inputData })
        // const reqJson = toJson(ExecuteRequestSchema, req)
        // console.log('terminalStdin', reqJson)
        streams?.sendExecuteRequest(req)
      }
    },
    onDidReceiveMessage: (listener: VSCodeEvent<any>) => {
      streams?.setCallback(listener)
    },
  } as Partial<RendererContext<void>>)

  useEffect(() => {
    const stdoutSub = streams?.stdout.subscribe((data: Uint8Array) => {
      onStdout?.(data)
    })
    return () => stdoutSub?.unsubscribe()
  }, [streams, onStdout])

  useEffect(() => {
    const stderrSub = streams?.stderr.subscribe((data: Uint8Array) => {
      onStderr?.(data)
    })
    return () => stderrSub?.unsubscribe()
  }, [streams, onStderr])

  useEffect(() => {
    const exitCodeSub = streams?.exitCode.subscribe((code: number) => {
      onExitCode?.(code)
      // close the stream when the exit code is received
      streams?.close()
    })
    return () => exitCodeSub?.unsubscribe()
  }, [streams, onExitCode])

  useEffect(() => {
    const pidSub = streams?.pid.subscribe((pid: number) => {
      onPid?.(pid)
    })
    return () => pidSub?.unsubscribe()
  }, [streams, onPid])

  useEffect(() => {
    const mimeTypeSub = streams?.mimeType.subscribe((mimeType: string) => {
      onMimeType?.(mimeType)
    })
    return () => mimeTypeSub?.unsubscribe()
  }, [streams, onMimeType])

  useEffect(() => {
    if (!streams || !executeRequest) {
      return
    }
    console.log(
      'useEffect invoked - Commands changed:',
      JSON.stringify(executeRequest.config!.source!.value)
    )
    streams?.sendExecuteRequest(executeRequest)
  }, [executeRequest, streams])

  return (
    <div
      className={className}
      ref={(el) => {
        if (!el || el.hasChildNodes()) {
          return
        }
        const terminalElem = document.createElement('terminal-view')
        terminalElem.setAttribute('buttons', 'false')

        terminalElem.setAttribute(
          'id',
          webComponentDefaults.output['runme.dev/id']!
        )
        terminalElem.setAttribute(
          'fontFamily',
          webComponentDefaults.output.fontFamily
        )
        if (typeof webComponentDefaults.output.fontSize === 'number') {
          terminalElem.setAttribute(
            'fontSize',
            webComponentDefaults.output.fontSize.toString()
          )
        }
        if (webComponentDefaults.output.cursorStyle) {
          terminalElem.setAttribute(
            'cursorStyle',
            webComponentDefaults.output.cursorStyle
          )
        }
        if (typeof webComponentDefaults.output.cursorBlink === 'boolean') {
          terminalElem.setAttribute(
            'cursorBlink',
            webComponentDefaults.output.cursorBlink ? 'true' : 'false'
          )
        }
        if (typeof webComponentDefaults.output.cursorWidth === 'number') {
          terminalElem.setAttribute(
            'cursorWidth',
            webComponentDefaults.output.cursorWidth.toString()
          )
        }

        if (typeof webComponentDefaults.output.takeFocus === 'boolean') {
          terminalElem.setAttribute(
            'takeFocus',
            webComponentDefaults.output.takeFocus ? 'true' : 'false'
          )
        }

        if (
          typeof webComponentDefaults.output.smoothScrollDuration === 'number'
        ) {
          terminalElem.setAttribute(
            'smoothScrollDuration',
            webComponentDefaults.output.smoothScrollDuration.toString()
          )
        }

        if (typeof webComponentDefaults.output.scrollback === 'number') {
          terminalElem.setAttribute(
            'scrollback',
            webComponentDefaults.output.scrollback.toString()
          )
        }
        if (webComponentDefaults.output.initialRows !== undefined) {
          terminalElem.setAttribute(
            'initialRows',
            webComponentDefaults.output.initialRows.toString()
          )
        }

        if (webComponentDefaults.output.content !== undefined) {
          terminalElem.setAttribute(
            'initialContent',
            webComponentDefaults.output.content
          )
        }

        if (webComponentDefaults.output.isAutoSaveEnabled) {
          terminalElem.setAttribute(
            'isAutoSaveEnabled',
            webComponentDefaults.output.isAutoSaveEnabled.toString()
          )
        }

        if (webComponentDefaults.output.isPlatformAuthEnabled) {
          terminalElem.setAttribute(
            'isPlatformAuthEnabled',
            webComponentDefaults.output.isPlatformAuthEnabled.toString()
          )
        }

        el.appendChild(terminalElem)
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
