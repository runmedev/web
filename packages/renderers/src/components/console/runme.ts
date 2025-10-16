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
import { LitElement, PropertyValues, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { Disposable } from 'vscode'
import { type RendererContext } from 'vscode-notebook-renderer'
import { type VSCodeEvent } from 'vscode-notebook-renderer/events'

import { setContext } from '../../messaging'
import Streams from '../../streams'
import { ClientMessages, TerminalConfiguration } from '../../types'
import { ConsoleView } from './view'

// Streams integration specific interfaces and constants

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

  // Properties delegated to ConsoleView
  @property({ type: String })
  id!: string

  @property({
    type: Boolean,
    converter: (value: string | null) => value !== 'false',
  })
  buttons: boolean = true

  @property({
    type: Boolean,
    converter: (value: string | null) => value !== 'false',
  })
  takeFocus: boolean = true

  @property({ type: String })
  theme: 'dark' | 'light' | 'vscode' = 'dark'

  @property({ type: String })
  fontFamily?: TerminalConfiguration['fontFamily']

  @property({ type: Number })
  fontSize?: TerminalConfiguration['fontSize']

  @property({ type: String })
  cursorStyle?: TerminalConfiguration['cursorStyle']

  @property({ type: Boolean })
  cursorBlink?: TerminalConfiguration['cursorBlink']

  @property({ type: Number })
  cursorWidth?: TerminalConfiguration['cursorWidth']

  @property({ type: Number })
  smoothScrollDuration?: TerminalConfiguration['smoothScrollDuration']

  @property({ type: Number })
  scrollback?: TerminalConfiguration['scrollback']

  @property({ type: String })
  initialContent?: string

  @property({ type: Number })
  initialRows?: number

  @property({ type: Number })
  lastLine?: number // TODO: Get the last line of the terminal and store it.

  @property({ type: Boolean })
  isLoading: boolean = false

  @property({ type: Boolean })
  isCreatingEscalation: boolean = false

  @property()
  shareUrl?: string

  @property()
  escalationUrl?: string

  @property({ type: Boolean })
  isUpdatedReady: boolean = false

  @property({ type: Boolean })
  isAutoSaveEnabled: boolean = false

  @property({ type: Boolean })
  isPlatformAuthEnabled: boolean = false

  @property({ type: Boolean })
  isDaggerOutput: boolean = false

  // Streams-specific properties
  @property({ type: String })
  knownId?: string
  @property({ type: String })
  runId?: string
  @property({ type: Number })
  sequence?: number
  @property({ type: String })
  languageId?: string
  @property({ type: Array, attribute: false })
  commands?: string[]
  @property({ type: String })
  runnerEndpoint?: string
  @property({
    type: Boolean,
    converter: (value: string | null) => value !== 'false',
  })
  reconnect: boolean = true
  @property({ attribute: false })
  interceptors: any[] = []

  constructor() {
    super()
    this.#installContextBridge()
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
      changedProperties.has('knownId') ||
      changedProperties.has('runId') ||
      changedProperties.has('sequence') ||
      changedProperties.has('runnerEndpoint') ||
      changedProperties.has('interceptors') ||
      changedProperties.has('commands') ||
      changedProperties.has('languageId')
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
    this.consoleView.setAttribute('buttons', this.buttons.toString())
    this.consoleView.setAttribute('takeFocus', this.takeFocus.toString())
    this.consoleView.setAttribute('theme', this.theme)

    if (this.fontFamily) {
      this.consoleView.setAttribute('fontFamily', this.fontFamily)
    }
    if (this.fontSize !== undefined) {
      this.consoleView.setAttribute('fontSize', this.fontSize.toString())
    }
    if (this.cursorStyle) {
      this.consoleView.setAttribute('cursorStyle', this.cursorStyle)
    }
    if (this.cursorBlink !== undefined) {
      this.consoleView.setAttribute('cursorBlink', this.cursorBlink.toString())
    }
    if (this.cursorWidth !== undefined) {
      this.consoleView.setAttribute('cursorWidth', this.cursorWidth.toString())
    }
    if (this.smoothScrollDuration !== undefined) {
      this.consoleView.setAttribute(
        'smoothScrollDuration',
        this.smoothScrollDuration.toString()
      )
    }
    if (this.scrollback !== undefined) {
      this.consoleView.setAttribute('scrollback', this.scrollback.toString())
    }
    if (this.initialContent) {
      this.consoleView.setAttribute('initialContent', this.initialContent)
    }
    if (this.initialRows !== undefined) {
      this.consoleView.setAttribute('initialRows', this.initialRows.toString())
    }
    if (this.lastLine !== undefined) {
      this.consoleView.setAttribute('lastLine', this.lastLine.toString())
    }
    if (this.isLoading !== undefined) {
      this.consoleView.setAttribute('isLoading', this.isLoading.toString())
    }
    if (this.isCreatingEscalation !== undefined) {
      this.consoleView.setAttribute(
        'isCreatingEscalation',
        this.isCreatingEscalation.toString()
      )
    }
    if (this.shareUrl) {
      this.consoleView.setAttribute('shareUrl', this.shareUrl)
    }
    if (this.escalationUrl) {
      this.consoleView.setAttribute('escalationUrl', this.escalationUrl)
    }
    if (this.isUpdatedReady !== undefined) {
      this.consoleView.setAttribute(
        'isUpdatedReady',
        this.isUpdatedReady.toString()
      )
    }
    if (this.isAutoSaveEnabled !== undefined) {
      this.consoleView.setAttribute(
        'isAutoSaveEnabled',
        this.isAutoSaveEnabled.toString()
      )
    }
    if (this.isPlatformAuthEnabled !== undefined) {
      this.consoleView.setAttribute(
        'isPlatformAuthEnabled',
        this.isPlatformAuthEnabled.toString()
      )
    }
    if (this.isDaggerOutput !== undefined) {
      this.consoleView.setAttribute(
        'isDaggerOutput',
        this.isDaggerOutput.toString()
      )
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
    if (this.#streams) {
      return
    }
    const knownId = this.knownId ?? this.id
    if (!knownId || !this.runId || !this.runnerEndpoint) {
      return
    }
    this.#streams = new Streams({
      knownID: knownId,
      runID: this.runId!,
      sequence: this.sequence ?? 0,
      options: {
        runnerEndpoint: this.runnerEndpoint!,
        interceptors: (this.interceptors as any[]) ?? [],
        autoReconnect: this.reconnect,
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
    if (!this.commands || !this.runId) {
      return
    }
    const req = this.#buildExecuteRequest()
    if (!req) {
      return
    }
    this.#streams.sendExecuteRequest(req as any)
  }

  #buildExecuteRequest(): any {
    const lid = this.languageId || 'sh'
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
          `RUNME_ID=${this.knownId ?? this.id}`,
          'RUNME_RUNNER=v2',
          'TERM=xterm-256color',
        ],
        interactive: true,
        runId: this.runId,
        knownId: this.knownId ?? this.id,
      },
      winsize: create(WinsizeSchema, this.#winsize),
    })
    if (this.commands?.length === 0) {
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
          items: this.commands ?? [],
        }),
      }
      req.config!.mode = CommandMode.INLINE
    } else {
      req.config!.source = {
        case: 'script',
        value: (this.commands ?? []).join('\n'),
      }
      req.config!.mode = CommandMode.FILE
      req.config!.fileExtension = this.languageId || ''
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
      setContext(ctxLike)
    } catch {
      console.error('Failed to set context bridge')
    }
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
