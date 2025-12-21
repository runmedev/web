import {
  CommandMode,
  ProgramConfig_CommandListSchema,
} from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/config_pb'
import {
  ExecuteRequestSchema,
  SessionStrategy,
  WinsizeSchema,
} from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { create } from '@bufbuild/protobuf'
import { Interceptor } from '@connectrpc/connect'
import { LitElement, PropertyValues, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { Disposable } from 'vscode'
import { type RendererContext } from 'vscode-notebook-renderer'
import { type VSCodeEvent } from 'vscode-notebook-renderer/events'

import { getContext, setContext } from '../../messaging'
import Streams from '../../streams'
import { ClientMessages } from '../../types'
import { ConsoleView, ConsoleViewConfig } from './view'

export interface RunmeConsoleStream {
  knownID: string
  runID: string
  sequence: number
  languageID?: string
  runnerEndpoint: string
  reconnect: boolean
}

export const RUNME_CONSOLE = 'runme-console'

@customElement(RUNME_CONSOLE)
export class RunmeConsole extends LitElement {
  protected disposables: Disposable[] = []

  // Internal ConsoleView instance
  protected consoleView?: ConsoleView

  // Streams-specific state
  #streams?: Streams
  #streamsUnsubs: Array<() => void> = []
  #winsize = { rows: 34, cols: 100, x: 0, y: 0 }
  #contextBridge?: RendererContext<void>

  // Properties delegated to ConsoleView
  @property({ type: String })
  id!: string

  @property({
    type: Boolean,
    converter: (value: string | null) => value !== 'false',
  })
  takeFocus: boolean = true

  @property({ type: Object })
  view: ConsoleViewConfig = {
    theme: 'dark',
    fontFamily: 'monospace',
    fontSize: 12,
    cursorStyle: 'block',
    cursorBlink: true,
    cursorWidth: 1,
    smoothScrollDuration: 0,
    scrollback: 4000,
  }

  @property({ type: Array })
  commands: string[] = []

  @property({ type: String })
  initialContent?: string

  @property({ type: Number })
  initialRows?: number

  // Streams-specific properties
  @property({ type: Object })
  stream?: RunmeConsoleStream

  @property({ attribute: false })
  interceptors: Interceptor[] = []

  constructor() {
    super()
    this.#contextBridge = this.#installContextBridge()
  }

  // Delegate theme styles to ConsoleView
  protected applyThemeStyles(): void {
    if (this.consoleView) {
      ;(this.consoleView as any).applyThemeStyles()
    }
  }

  connectedCallback(): void {
    super.connectedCallback()

    if (!this.id) {
      throw new Error('No id provided to terminal!')
    }

    // Create and setup ConsoleView
    this.#setupConsoleView()

    // Setup Streams integration
    this.#maybeInitStreams()
    this.#maybeSendExecuteRequest()
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.#teardownStreams()
    this.disposables.forEach(({ dispose }) => dispose())
  }

  protected updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties)

    // Delegate property updates to ConsoleView
    if (this.consoleView) {
      this.#updateConsoleViewProperties()
    }

    // Handle Streams-specific property changes
    if (
      changedProperties.has('id') ||
      changedProperties.has('stream') ||
      changedProperties.has('commands')
    ) {
      this.#maybeInitStreams()
      this.#maybeSendExecuteRequest()
    }
  }

  protected firstUpdated(props: PropertyValues): void {
    super.firstUpdated(props)
    // ConsoleView handles its own firstUpdated logic
  }

  // Setup ConsoleView instance and delegate properties
  #setupConsoleView(): void {
    if (!this.shadowRoot) {
      return
    }

    // Create ConsoleView element
    this.consoleView = document.createElement('console-view') as ConsoleView
    // Share the per-instance messaging context with the child ConsoleView
    if (this.#contextBridge) {
      this.consoleView.context = this.#contextBridge
    }

    // Set all properties on ConsoleView
    this.#updateConsoleViewProperties()

    // Add to shadow DOM
    this.shadowRoot.appendChild(this.consoleView)

    // Listen to ConsoleView events and forward to Streams
    this.#setupEventListeners()
  }

  #updateConsoleViewProperties(): void {
    if (!this.consoleView) {
      return
    }

    // Delegate all standard terminal properties to ConsoleView
    this.consoleView.setAttribute('id', this.id)
    // Always disable buttons by default
    this.consoleView.setAttribute('buttons', 'false')
    this.consoleView.setAttribute('takeFocus', this.takeFocus.toString())
    this.consoleView.setAttribute('theme', this.view.theme)

    if (this.view.fontFamily) {
      this.consoleView.setAttribute('fontFamily', this.view.fontFamily)
    }
    if (this.view.fontSize) {
      this.consoleView.setAttribute('fontSize', this.view.fontSize.toString())
    }
    if (this.view.cursorStyle) {
      this.consoleView.setAttribute('cursorStyle', this.view.cursorStyle)
    }
    if (this.view.cursorBlink) {
      this.consoleView.setAttribute(
        'cursorBlink',
        this.view.cursorBlink.toString()
      )
    }
    if (this.view.cursorWidth) {
      this.consoleView.setAttribute(
        'cursorWidth',
        this.view.cursorWidth.toString()
      )
    }
    if (this.view.smoothScrollDuration) {
      this.consoleView.setAttribute(
        'smoothScrollDuration',
        this.view.smoothScrollDuration.toString()
      )
    }
    if (this.view.scrollback) {
      this.consoleView.setAttribute(
        'scrollback',
        this.view.scrollback.toString()
      )
    }

    if (this.initialContent) {
      this.consoleView.setAttribute('initialContent', this.initialContent)
    }

    if (this.initialRows !== undefined) {
      this.consoleView.setAttribute('initialRows', this.initialRows.toString())
    }
  }

  #setupEventListeners(): void {
    if (!this.consoleView) {
      return
    }

    // Listen to ConsoleView events and dispatch them on this element
    const eventHandler = (eventName: string) => (e: Event) => {
      this.dispatchEvent(
        new CustomEvent(eventName, { detail: (e as CustomEvent).detail })
      )
    }

    this.consoleView.addEventListener('stdout', eventHandler('stdout'))
    this.consoleView.addEventListener('stderr', eventHandler('stderr'))
    this.consoleView.addEventListener('exitcode', eventHandler('exitcode'))
    this.consoleView.addEventListener('pid', eventHandler('pid'))
    this.consoleView.addEventListener('mimetype', eventHandler('mimetype'))
  }

  // Streams integration helpers
  #maybeInitStreams() {
    if (this.#streams || !this.stream) {
      return
    }
    const knownID = this.stream.knownID ?? this.id
    if (!knownID || !this.stream.runID || !this.stream.runnerEndpoint) {
      throw new Error('Missing required stream properties')
    }
    this.#streams = new Streams({
      knownID: knownID,
      runID: this.stream.runID!,
      sequence: this.stream.sequence ?? 0,
      options: {
        runnerEndpoint: this.stream.runnerEndpoint,
        autoReconnect: this.stream.reconnect,
        interceptors: this.interceptors ?? [],
      },
    })
    const latencySub = this.#streams.connect().subscribe()
    this.#streamsUnsubs.push(() => latencySub.unsubscribe())

    const stdoutSub = this.#streams.stdout.subscribe((data: Uint8Array) => {
      this.dispatchEvent(new CustomEvent('stdout', { detail: data }))
      // Write to ConsoleView's terminal
      if (this.consoleView && (this.consoleView as any).terminal) {
        ;(this.consoleView as any).terminal.write(data)
      }
    })
    const stderrSub = this.#streams.stderr.subscribe((data: Uint8Array) => {
      this.dispatchEvent(new CustomEvent('stderr', { detail: data }))
    })
    const exitSub = this.#streams.exitCode.subscribe((code: number) => {
      this.dispatchEvent(new CustomEvent('exitcode', { detail: code }))
      this.#teardownStreams()
    })
    const pidSub = this.#streams.pid.subscribe((pid: number) => {
      this.dispatchEvent(new CustomEvent('pid', { detail: pid }))
    })
    const mimeSub = this.#streams.mimeType.subscribe((mt: string) => {
      this.dispatchEvent(new CustomEvent('mimetype', { detail: mt }))
    })
    this.#streamsUnsubs.push(() => stdoutSub.unsubscribe())
    this.#streamsUnsubs.push(() => stderrSub.unsubscribe())
    this.#streamsUnsubs.push(() => exitSub.unsubscribe())
    this.#streamsUnsubs.push(() => pidSub.unsubscribe())
    this.#streamsUnsubs.push(() => mimeSub.unsubscribe())
  }

  #teardownStreams() {
    this.#streamsUnsubs.forEach((u) => {
      try {
        u()
      } catch {}
    })
    this.#streamsUnsubs = []
    this.#streams?.close()
    this.#streams = undefined
  }

  #maybeSendExecuteRequest() {
    if (!this.#streams) {
      return
    }
    if (!this.commands.length || !this.stream?.runID) {
      return
    }
    const req = this.#buildExecuteRequest()
    if (!req) {
      return
    }
    this.#streams.sendExecuteRequest(req as any)
  }

  #buildExecuteRequest(): any {
    const lid = this.stream?.languageID || 'sh'
    const shellish = new Set([
      'sh',
      'shell',
      'bash',
      'zsh',
      'fish',
      'ksh',
      'csh',
      'tcsh',
      'dash',
      'powershell',
      'pwsh',
      'cmd',
      'ash',
      'elvish',
      'xonsh',
    ])
    const isShellish = shellish.has(lid)
    const req = create(ExecuteRequestSchema, {
      sessionStrategy: SessionStrategy.MOST_RECENT,
      storeStdoutInEnv: true,
      config: {
        languageId: lid,
        background: false,
        fileExtension: '',
        env: [
          `RUNME_ID=${this.stream?.knownID ?? this.id}`,
          'RUNME_RUNNER=v2',
          'TERM=xterm-256color',
        ],
        interactive: true,
        runId: this.stream?.runID,
        knownId: this.stream?.knownID ?? this.id,
      },
      winsize: create(WinsizeSchema, this.#winsize),
    })
    if (this.commands.length === 0) {
      req.config!.mode = CommandMode.INLINE
      req.config!.source = {
        case: 'commands',
        value: create(ProgramConfig_CommandListSchema, {
          items: ['zsh -l'],
        }),
      }
    } else if (isShellish) {
      req.config!.source = {
        case: 'commands',
        value: create(ProgramConfig_CommandListSchema, {
          items: this.commands,
        }),
      }
      req.config!.mode = CommandMode.INLINE
    } else {
      req.config!.source = {
        case: 'script',
        value: this.commands.join('\n'),
      }
      req.config!.mode = CommandMode.FILE
      req.config!.fileExtension = this.stream?.languageID ?? ''
    }
    return req
  }

  #installContextBridge() {
    const encoder = new TextEncoder()
    const ctxLike = {
      postMessage: (message: unknown) => {
        if (
          (message as any).type === ClientMessages.terminalOpen ||
          (message as any).type === ClientMessages.terminalResize
        ) {
          const cols = Number(
            (message as any).output.terminalDimensions.columns
          )
          const rows = Number((message as any).output.terminalDimensions.rows)
          if (Number.isFinite(cols) && Number.isFinite(rows)) {
            // If the dimensions are the same, return early
            if (this.#winsize.cols === cols && this.#winsize.rows === rows) {
              return
            }
            this.#winsize = create(WinsizeSchema, {
              cols,
              rows,
              x: 0,
              y: 0,
            })
            const req = create(ExecuteRequestSchema, {
              winsize: this.#winsize,
            })
            this.#streams?.sendExecuteRequest(req)
          }
        }

        if ((message as any).type === ClientMessages.terminalStdin) {
          const inputData = encoder.encode((message as any).output.input)
          const req = create(ExecuteRequestSchema, { inputData })
          // const reqJson = toJson(ExecuteRequestSchema, req)
          // console.log('terminalStdin', reqJson)
          this.#streams?.sendExecuteRequest(req)
        }
      },
      onDidReceiveMessage: (listener: VSCodeEvent<any>) => {
        this.#streams?.setCallback(listener)
      },
    } as RendererContext<void>
    try {
      // Retain legacy behavior of setting the module-level context so
      // existing consumers continue to work, but also return the instance
      // bridge for per-instance use.
      setContext(ctxLike)
      this.consoleView && (this.consoleView.context = ctxLike)
      this.#contextBridge = ctxLike
    } catch {
      console.error('Failed to set context bridge')
    }
    return ctxLike
  }

  // Render the UI - just render ConsoleView which handles everything
  render() {
    return html`<div></div>`
  }

  dispose() {
    this.#teardownStreams()
    this.disposables.forEach(({ dispose }) => dispose())
  }
}
