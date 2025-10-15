import { LitElement, css, html, PropertyValues, unsafeCSS } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { when } from 'lit/directives/when.js'
import { Disposable, TerminalDimensions } from 'vscode'
import { ITheme, Terminal as XTermJS } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Observable } from 'rxjs'
import { debounceTime, distinctUntilChanged, filter, map, share } from 'rxjs/operators'

import { FitAddon, type ITerminalDimensions } from '../../fitAddon'
import { ClientMessages, OutputType, TerminalConfiguration, WebViews } from '../../types'
import { closeOutput } from '../../utils'
import { onClientMessage, postClientMessage, getContext, setContext } from '../../messaging'
import {
  ClientMessage,
} from '../../types'
import Streams from '../../streams'
import '../closeCellButton'
import '../copyButton'
import './actionButton'
import './gistCell'
import './open'
import './saveButton'
import './shareButton'
import { darkStyles, lightStyles } from './vscode.css'
import { create } from '@bufbuild/protobuf'
import { ExecuteRequestSchema, SessionStrategy, WinsizeSchema } from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { ProgramConfig_CommandListSchema, CommandMode } from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/config_pb'
import { RendererContext } from 'vscode-notebook-renderer'

interface IWindowSize {
  width: number
  height: number
}

enum MessageOptions {
  OpenLink = 'Open',
  CopyToClipboard = 'Copy to clipboard',
  Cancel = 'Cancel',
}

const vscodeCSS = (...identifiers: string[]) => `--vscode-${identifiers.join('-')}`
const terminalCSS = (id: string) => vscodeCSS('terminal', id)
const toAnsi = (id: string) => `ansi${id.charAt(0).toUpperCase() + id.slice(1)}`
const LISTEN_TO_EVENTS = [
  'terminal:',
  'theme:',
  ClientMessages.platformApiRequest,
  ClientMessages.platformApiResponse,
  ClientMessages.onOptionsMessage,
  ClientMessages.optionsMessage,
  ClientMessages.onCopyTextToClipboard,
  ClientMessages.onProgramClose,
  ClientMessages.featuresResponse,
  ClientMessages.featuresUpdateAction,
]

const ANSI_COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',

  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] satisfies (keyof ITheme)[]

export const CONSOLE_VIEW = 'console-view'

@customElement(CONSOLE_VIEW)
export class ConsoleView extends LitElement {
  protected copyText = 'Copy'

  static styles = css`
    .xterm {
      cursor: text;
      position: relative;
      padding: 10px;
      user-select: none;
      -ms-user-select: none;
      -webkit-user-select: none;
    }

    .xterm.focus,
    .xterm:focus {
      border: solid 1px var(--vscode-focusBorder);
    }

    .xterm .xterm-helpers {
      position: absolute;
      top: 0;
      /**
         * The z-index of the helpers must be higher than the canvases in order for
         * IMEs to appear on top.
         */
      z-index: 5;
    }

    .xterm .xterm-helper-textarea {
      padding: 0;
      border: 0;
      margin: 0;
      /* Move textarea out of the screen to the far left, so that the cursor is not visible */
      position: absolute;
      opacity: 0;
      left: -9999em;
      top: 0;
      width: 0;
      height: 0;
      z-index: -5;
      /** Prevent wrapping so the IME appears against the textarea at the correct position */
      white-space: nowrap;
      overflow: hidden;
      resize: none;
    }

    .xterm .composition-view {
      color: #fff;
      display: none;
      position: absolute;
      white-space: nowrap;
      z-index: 1;
    }

    .xterm .composition-view.active {
      display: block;
    }

    .xterm .xterm-viewport {
      background-color: var(${unsafeCSS(terminalCSS('background'))}) !important;
      border: solid 1px var(--vscode-terminal-border);
      /* On OS X this is required in order for the scroll bar to appear fully opaque */
      overflow-y: scroll;
      cursor: default;
      position: absolute;
      right: 0;
      left: 0;
      top: 0;
      bottom: 0;
    }

    .xterm .xterm-screen {
      position: relative;
    }

    .xterm .xterm-screen canvas {
      position: absolute;
      left: 0;
      top: 0;
    }

    .xterm-viewport::-webkit-scrollbar {
      width: 10px;
    }

    .xterm-viewport::-webkit-scrollbar-thumb {
      background-color: rgba(0, 0, 0, 0);
      min-height: 20px;
    }

    .xterm:hover .xterm-viewport::-webkit-scrollbar-thumb {
      background-color: var(${unsafeCSS(vscodeCSS('scrollbarSlider', 'background'))});
    }

    .xterm:hover .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background-color: var(${unsafeCSS(vscodeCSS('scrollbarSlider', 'hoverBackground'))});
    }

    .xterm:hover .xterm-viewport::-webkit-scrollbar-thumb:active {
      background-color: var(${unsafeCSS(vscodeCSS('scrollbarSlider', 'activeBackground'))});
    }

    .xterm .xterm-scroll-area {
      visibility: hidden;
    }

    .xterm-char-measure-element {
      display: inline-block;
      visibility: hidden;
      position: absolute;
      top: 0;
      left: -9999em;
      line-height: normal;
    }

    .xterm.enable-mouse-events {
      /* When mouse events are enabled (eg. tmux), revert to the standard pointer cursor */
      cursor: default;
    }

    .xterm.xterm-cursor-pointer,
    .xterm .xterm-cursor-pointer {
      cursor: pointer;
    }

    .xterm.column-select.focus {
      /* Column selection mode */
      cursor: crosshair;
    }

    .xterm .xterm-accessibility,
    .xterm .xterm-message {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 10;
      color: transparent;
    }

    .xterm .live-region {
      position: absolute;
      left: -9999px;
      width: 1px;
      height: 1px;
      overflow: hidden;
    }

    .xterm-dim {
      opacity: 0.5;
    }

    .xterm-underline-1 {
      text-decoration: underline;
    }
    .xterm-underline-2 {
      text-decoration: double underline;
    }
    .xterm-underline-3 {
      text-decoration: wavy underline;
    }
    .xterm-underline-4 {
      text-decoration: dotted underline;
    }
    .xterm-underline-5 {
      text-decoration: dashed underline;
    }

    .xterm-strikethrough {
      text-decoration: line-through;
    }

    .xterm-screen .xterm-decoration-container .xterm-decoration {
      z-index: 6;
      position: absolute;
    }

    .xterm-decoration-overview-ruler {
      z-index: 7;
      position: absolute;
      top: 0;
      right: 0;
      pointer-events: none;
    }

    .xterm-decoration-top {
      z-index: 2;
      position: relative;
    }

    vscode-button {
      color: var(--vscode-button-foreground);
      background-color: var(--vscode-button-background);
      transform: scale(0.9);
    }
    vscode-button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    vscode-button:focus {
      outline: #007fd4 1px solid;
    }
    .icon {
      width: 13px;
      margin: 0 5px 0 -5px;
      padding: 0;
    }

    .button-group {
      display: flex;
      flex-direction: row;
      justify-content: end;
    }

    section {
      display: flex;
      flex-direction: column;
      gap: 5px;
      position: relative;
    }

    .xterm-drag-handle {
      width: 100%;
      position: absolute;
      bottom: -5px;
      height: 10px;
      cursor: row-resize;
    }

    #terminal {
      position: relative;
    }

    /** xf styles */
    .xterm-bg-257,
    .xterm-bg-7 {
      background-color: var(--vscode-editor-selectionBackground) !important;
    }
  `

  protected disposables: Disposable[] = []
  protected terminal?: XTermJS
  protected fitAddon?: FitAddon
  protected serializer?: SerializeAddon
  protected windowSize: IWindowSize
  protected rows: number = 10
  protected themeStyleSheet?: CSSStyleSheet

  protected platformId?: string
  protected exitCode?: number | void
  protected isSlackReady?: boolean
  protected isShareReady: boolean = false

  // @state()
  // protected featureState$?: FeatureObserver

  @property({ type: String })
  id!: string

  @property({ type: Boolean, converter: (value: string | null) => value !== 'false' })
  buttons: boolean = true

  @property({ type: Boolean, converter: (value: string | null) => value !== 'false' })
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

  // Execution configuration
  @property({ type: String })
  knownId?: string
  @property({ type: String })
  runId?: string
  @property({ type: Number })
  sequence?: number
  @property({ type: String })
  languageId?: string
  @property({ attribute: false })
  commands?: string[]
  @property({ type: String })
  runnerEndpoint?: string
  @property({ type: Boolean, converter: (value: string | null) => value !== 'false' })
  reconnect: boolean = true
  @property({ attribute: false })
  interceptors: any[] = []

  // Internal streams state
  #streams?: Streams
  #streamsUnsubs: Array<() => void> = []
  #winsize = { rows: 34, cols: 100, x: 0, y: 0 }

  @property({ type: Boolean })
  isDaggerOutput: boolean = false

  constructor() {
    super()

    this.#installContextBridge()

    this.windowSize = {
      height: window.innerHeight,
      width: window.innerWidth,
    }
  }

  protected applyThemeStyles(): void {
    if (!this.shadowRoot) {
      return
    }

    // Remove existing theme stylesheet if it exists
    if (this.themeStyleSheet) {
      const index = this.shadowRoot.adoptedStyleSheets.indexOf(this.themeStyleSheet)
      if (index !== -1) {
        this.shadowRoot.adoptedStyleSheets = this.shadowRoot.adoptedStyleSheets.filter(
          (_, i) => i !== index
        )
      }
      this.themeStyleSheet = undefined
    }

    // Apply new theme styles
    if (this.theme === 'dark') {
      this.themeStyleSheet = new CSSStyleSheet()
      this.themeStyleSheet.replaceSync(darkStyles.cssText)
      this.shadowRoot.adoptedStyleSheets = [
        ...this.shadowRoot.adoptedStyleSheets,
        this.themeStyleSheet
      ]
    } else if (this.theme === 'light') {
      this.themeStyleSheet = new CSSStyleSheet()
      this.themeStyleSheet.replaceSync(lightStyles.cssText)
      this.shadowRoot.adoptedStyleSheets = [
        ...this.shadowRoot.adoptedStyleSheets,
        this.themeStyleSheet
      ]
    }
    // For 'vscode' theme, no additional styles are applied
  }

  connectedCallback(): void {
    super.connectedCallback()

    // Apply theme-specific styles
    this.applyThemeStyles()


    if (!this.id) {
      throw new Error('No id provided to terminal!')
    }

    this.rows = this.initialRows ?? this.rows

    const {
      rows,
      cursorBlink,
      fontSize,
      cursorStyle,
      cursorWidth,
      fontFamily,
      smoothScrollDuration,
      scrollback,
    } = this
    this.terminal = new XTermJS({
      rows,
      fontSize,
      fontFamily,
      scrollback,
      cursorWidth,
      cursorBlink,
      cursorStyle,
      smoothScrollDuration,
      disableStdin: false,
      convertEol: true,
      allowProposedApi: true,
      drawBoldTextInBrightColors: false,
    })

    if (this.initialContent) {
      this.terminal?.write(this.initialContent)
    }

    this.fitAddon = new FitAddon()
    this.fitAddon.activate(this.terminal!)

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)
    this.terminal.loadAddon(new Unicode11Addon())
    this.terminal.loadAddon(new WebLinksAddon(this.#onWebLinkClick.bind(this)))

    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.shiftKey && event.ctrlKey && event.code === 'KeyC') {
        const selection = this?.terminal?.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          return false
        }
      }
      return true
    })
    this.terminal.unicode.activeVersion = '11'
    this.terminal.options.drawBoldTextInBrightColors

    const ctx = getContext()

    this.disposables.push(
      // todo(sebastian): what's the type of e?
      onClientMessage(ctx, async (e: any) => {
        if (!LISTEN_TO_EVENTS.some((event) => e.type.startsWith(event))) {
          return
        }

        switch (e.type) {
          // case ClientMessages.featuresResponse:
          // case ClientMessages.featuresUpdateAction:
          //   this.featureState$ = features.loadSnapshot(e.output.snapshot)
          //   break
          case ClientMessages.activeThemeChanged:
            this.#updateTerminalTheme()
            break
          case ClientMessages.terminalStdout:
          case ClientMessages.terminalStderr:
            {
              const { 'runme.dev/id': id, data } = e.output
              if (id !== this.id) {
                return
              }
              this.isShareReady = false
              this.terminal!.write(data)
              this.requestUpdate()
            }
            break
          case ClientMessages.platformApiResponse:
            {
              if (e.output.id !== this.id) {
                return
              }
              this.isLoading = false
              if (e.output.hasErrors) {
                return postClientMessage(ctx, ClientMessages.errorMessage, e.output.data)
              }

              if (
                e.output.data.hasOwnProperty('displayShare') &&
                e.output.data.displayShare === false
              ) {
                return
              }

              const data = (e.output.data?.data || {}) as any
              // TODO: Remove createCellExecution once the transition is complete and tested enough.
              if (data.createExtensionCellOutput || data.createCellExecution) {
                const objData = data.createCellExecution || data.createExtensionCellOutput || {}
                const { exitCode, id, htmlUrl, isSlackReady } = objData
                this.platformId = id
                this.shareUrl = htmlUrl || ''
                this.exitCode = exitCode
                this.isSlackReady = !!isSlackReady
                this.isShareReady = true
                // Dispatch tangle update event
                return postClientMessage(ctx, ClientMessages.tangleEvent, {
                  webviewId: WebViews.RunmeCloud,
                  data: {
                    cellId: id,
                  },
                })
              }
              if (data.updateCellOutput) {
                const {
                  updateCellOutput: { exitCode, isSlackReady },
                } = data
                this.isUpdatedReady = true
                this.exitCode = exitCode
                this.isSlackReady = !!isSlackReady
                this.#displayShareDialog()
              }

              if (data.createEscalation) {
                this.escalationUrl = data.createEscalation.escalationUrl!
              }
            }
            break

          case ClientMessages.onOptionsMessage:
            {
              if (e.output.id !== this.id) {
                return
              }
              const answer = e.output.option
              this.isLoading = false
              switch (answer) {
                case MessageOptions.OpenLink: {
                  return postClientMessage(ctx, ClientMessages.openExternalLink, {
                    link: this.shareUrl!,
                    telemetryEvent: 'app.openLink',
                  })
                }
                case MessageOptions.CopyToClipboard: {
                  return postClientMessage(ctx, ClientMessages.copyTextToClipboard, {
                    id: this.id!,
                    text: this.shareUrl!,
                  })
                }
              }
            }
            break
          case ClientMessages.onCopyTextToClipboard: {
            if (e.output.id !== this.id) {
              return
            }
            return postClientMessage(ctx, ClientMessages.infoMessage, 'Link copied!')
          }
          case ClientMessages.onProgramClose: {
            const { 'runme.dev/id': id, code } = e.output
            if (id !== this.id) {
              return
            }
            this.exitCode = code
            // if (features.isOn(FeatureName.SignedIn, this.featureState$) && this.isAutoSaveEnabled) {
            //   return this.#shareCellOutput(false)
            // }
            return
          }
        }
      }),
      this.terminal.onData((data) => this.#sendStdin(data)),
    )

    postClientMessage(ctx, ClientMessages.featuresRequest, {})
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.dispose()
  }

  protected updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties)

    if (changedProperties.has('theme')) {
      this.applyThemeStyles()
      this.#updateTerminalTheme()
    }

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
    const terminalContainer = this.#getTerminalElement() as HTMLElement

    if (this.takeFocus) {
      window.addEventListener('focus', () => {
        this.#onFocusWindow()
      })
    }

    window.addEventListener('click', () => {
      this.#onFocusWindow(false)
    })

    this.terminal!.open(terminalContainer)
    if (this.takeFocus) {
      this.terminal!.focus()
    }
    this.#resizeTerminal()
    this.#updateTerminalTheme()

    const resizeDragHandle = this.#createResizeHandle()
    const dims = new Observable<TerminalDimensions | undefined>((observer) => {
      window.addEventListener('resize', () => observer.next(this.#getDimensions(true)))
      terminalContainer.addEventListener('mouseup', () => observer.next(this.#getDimensions(false)))
    }).pipe(share())
    this.#subscribeResizeTerminal(dims)
    this.#subscribeSetTerminalRows(dims)
    terminalContainer.appendChild(resizeDragHandle)

    const ctx = getContext()
    ctx.postMessage &&
      postClientMessage(ctx, ClientMessages.terminalOpen, {
        'runme.dev/id': this.id!,
        terminalDimensions: convertXTermDimensions(this.fitAddon?.proposeDimensions()),
      })

    this.#maybeInitStreams()

    if (this.lastLine) {
      this.terminal!.scrollToLine(this.lastLine)
    }
  }

  #resizeTerminal(rows?: number) {
    if (rows !== undefined) {
      this.rows = rows
    }
    return this.fitAddon?.fit(this.rows)
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
      this.terminal?.write(data)
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
    const shellish = new Set(['sh','shell','bash','zsh','fish','ksh','csh','tcsh','dash','powershell','pwsh','cmd','ash','elvish','xonsh'])
    const isShellish = shellish.has(lid)
    const req = create(ExecuteRequestSchema, {
      sessionStrategy: SessionStrategy.MOST_RECENT,
      storeStdoutInEnv: true,
      config: {
        languageId: lid,
        background: false,
        fileExtension: '',
        env: [`RUNME_ID=${this.knownId ?? this.id}`, 'RUNME_RUNNER=v2', 'TERM=xterm-256color'],
        interactive: true,
        runId: this.runId,
        knownId: this.knownId ?? this.id,
      },
      winsize: create(WinsizeSchema, this.#winsize),
    })
    if (isShellish) {
      req.config!.source = { case: 'commands', value: create(ProgramConfig_CommandListSchema, { items: this.commands ?? [] }) }
      req.config!.mode = CommandMode.INLINE
    } else {
      req.config!.source = { case: 'script', value: (this.commands ?? []).join('\n') }
      req.config!.mode = CommandMode.FILE
      req.config!.fileExtension = this.languageId || ''
    }
    return req
  }

  #sendWinsize() {
    if (!this.#streams) {
      return
    }
    const req = create(ExecuteRequestSchema, { winsize: this.#winsize })
    this.#streams.sendExecuteRequest(req)
  }

  #sendStdin(input: string) {
    if (!this.#streams) {
      return
    }
    const encoder = new TextEncoder()
    const inputData = encoder.encode(input)
    const req = create(ExecuteRequestSchema, { inputData })
    this.#streams.sendExecuteRequest(req)
  }

  #installContextBridge() {
    const ctxLike = {
      postMessage: (message: any) => {
        if (
          message?.type === ClientMessages.terminalOpen ||
          message?.type === ClientMessages.terminalResize
        ) {
          const cols = Number(message?.output?.terminalDimensions?.columns)
          const rows = Number(message?.output?.terminalDimensions?.rows)
          if (Number.isFinite(cols) && Number.isFinite(rows)) {
            if (this.#winsize.cols === cols && this.#winsize.rows === rows) {
              return
            }
            this.#winsize = { cols, rows, x: 0, y: 0 }
            this.#sendWinsize()
          }
        }
        if (message?.type === ClientMessages.terminalStdin) {
          const input = String(message?.output?.input ?? '')
          this.#sendStdin(input)
        }
      },
      onDidReceiveMessage: (listener: (message: any) => void) => {
        if (this.#streams && typeof (this.#streams as any).setCallback === 'function') {
          ;(this.#streams as any).setCallback(listener as any)
        }
        return { dispose: () => {} }
      },
    } as RendererContext<void>
    try {
      setContext(ctxLike)
    } catch {
      console.error('Failed to set context bridge')
    }
  }

  #createResizeHandle(): HTMLElement {
    const dragHandle = document.createElement('div')
    dragHandle.setAttribute('class', 'xterm-drag-handle')

    let dragState:
      | {
          initialClientY: number
          initialRows: number
        }
      | undefined

    const onMouseDown = (e: MouseEvent) => {
      dragState = {
        initialClientY: e.clientY,
        initialRows: this.rows,
      }
      e.preventDefault()
      this.terminal?.focus()
    }

    const onMouseUp = () => {
      if (dragState === undefined) {
        return
      }
      dragState = undefined
    }

    const onMouseMove = (e: MouseEvent) => {
      if (dragState === undefined || !this.fitAddon) {
        return
      }

      const delta = e.clientY - dragState.initialClientY

      const deltaRows = delta / this.fitAddon.getCellSize().height
      const newRows = Math.round(dragState.initialRows + deltaRows)

      if (newRows !== this.rows) {
        this.#resizeTerminal(newRows)
        this.terminal?.focus()
      }
    }

    dragHandle.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousemove', onMouseMove)

    this.disposables.push({
      dispose: () => {
        dragHandle.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('mousemove', onMouseMove)
      },
    })

    return dragHandle
  }

  #getTerminalElement(): Element {
    return this.shadowRoot?.querySelector('#terminal')!
  }

  #updateTerminalTheme(): void {
    const foregroundColor = this.#getThemeHexColor(terminalCSS('foreground'))

    const terminalTheme: ITheme = {
      foreground: foregroundColor,
      cursor: this.#getThemeHexColor(vscodeCSS('terminalCursor', 'foreground')) || foregroundColor,
      cursorAccent: this.#getThemeHexColor(vscodeCSS('terminalCursor', 'background')),
      selectionForeground: this.#getThemeHexColor(terminalCSS('selectionForeground')),
      selectionBackground: this.#getThemeHexColor(terminalCSS('selectionBackground')),
      selectionInactiveBackground: this.#getThemeHexColor(
        terminalCSS('inactiveSelectionBackground'),
      ),
      ...Object.fromEntries(
        ANSI_COLORS.map((k) => [k, this.#getThemeHexColor(terminalCSS(toAnsi(k)))] as const),
      ),
    }
    this.terminal!.options.theme = terminalTheme
  }

  #getThemeHexColor(variableName: string): string | undefined {
    const terminalContainer = this.shadowRoot?.querySelector('#terminal')
    return getComputedStyle(terminalContainer!).getPropertyValue(variableName) ?? undefined
  }

  #getDimensions(checkWindowSize: boolean): TerminalDimensions | undefined {
    if (!this.fitAddon) {
      return
    }

    const { innerWidth, innerHeight } = window

    // Prevent adjusting the terminal size if window width & height remain the same
    if (
      checkWindowSize &&
      Math.abs(this.windowSize.width - innerWidth) <= Number.EPSILON &&
      Math.abs(this.windowSize.height - innerHeight) <= Number.EPSILON
    ) {
      return
    }

    this.windowSize.width = innerWidth

    const proposedDimensions = this.#resizeTerminal()

    if (proposedDimensions) {
      return convertXTermDimensions(proposedDimensions)
    }
  }

  async #subscribeResizeTerminal(
    proposedDimensions: Observable<TerminalDimensions | undefined>,
  ): Promise<void> {
    const debounced$ = proposedDimensions.pipe(
      filter((x) => !!x),
      distinctUntilChanged(),
      debounceTime(100),
    )

    const sub = debounced$.subscribe(async (terminalDimensions) => {
      const ctx = getContext()
      if (!ctx.postMessage) {
        return
      }

      await postClientMessage(ctx, ClientMessages.terminalResize, {
        'runme.dev/id': this.id!,
        terminalDimensions,
      })

      // Forward winsize to streams if initialized
      const cols = Number(terminalDimensions?.columns)
      const rows = Number(terminalDimensions?.rows)
      if (Number.isFinite(cols) && Number.isFinite(rows)) {
        if (this.#winsize.cols !== cols || this.#winsize.rows !== rows) {
          this.#winsize = { cols, rows, x: 0, y: 0 }
          this.#sendWinsize()
        }
      }
    })

    this.disposables.push({ dispose: () => sub.unsubscribe() })
  }

  async #subscribeSetTerminalRows(
    proposedDimensions: Observable<TerminalDimensions | undefined>,
  ): Promise<void> {
    const debounced$ = proposedDimensions.pipe(
      map((x) => x?.rows),
      filter((x) => !!x),
      distinctUntilChanged(),
      debounceTime(100),
    )

    const sub = debounced$.subscribe(async (terminalRows) => {
      const ctx = getContext()
      if (!ctx.postMessage) {
        return
      }

      // const parseResult = CellAnnotationsSchema.safeParse({
      //   'runme.dev/id': this.id!,
      //   terminalRows,
      // })
      // if (!parseResult.success) {
      //   console.error(parseResult.error.errors)
      //   return
      // }

      ctx.postMessage(<ClientMessage<ClientMessages.mutateAnnotations>>{
        type: ClientMessages.mutateAnnotations,
        output: {
          annotations: <Partial<any>>{
            'runme.dev/id': this.id!,
            terminalRows,
          },
        },
      })
    })

    this.disposables.push({ dispose: () => sub.unsubscribe() })
  }

  async #onFocusWindow(focusTerminal = true): Promise<void> {
    if (focusTerminal) {
      this.terminal?.focus()
    }

    const ctx = getContext()
    if (!ctx.postMessage) {
      return
    }

    await postClientMessage(ctx, ClientMessages.terminalFocus, {
      'runme.dev/id': this.id!,
    })
  }

  async #displayShareDialog(): Promise<boolean | void> {
    const ctx = getContext()
    if (!ctx.postMessage || !this.shareUrl) {
      return
    }

    return postClientMessage(ctx, ClientMessages.optionsMessage, {
      title:
        'Please share link with caution. Anyone with the link has access. Click "Open" to toggle visibility.',
      options: Object.values(MessageOptions),
      id: this.id!,
      telemetryEvent: 'app.share',
    })
  }

  async #triggerShareCellOutput(): Promise<boolean | void | undefined> {
    return this.#shareCellOutput(true)
  }

  async #triggerEscalation(): Promise<boolean | void | undefined> {
    // const ctx = getContext()
    this.isCreatingEscalation = true

    // try {
    //   await postClientMessage(ctx, ClientMessages.platformApiRequest, {
    //     data: {
    //       id: this.platformId,
    //     },
    //     id: this.id!,
    //     method: APIMethod.CreateEscalation,
    //   })
    // } catch (error) {
    //   postClientMessage(
    //     ctx,
    //     ClientMessages.infoMessage,
    //     `Failed to escalate: ${(error as any).message}`,
    //   )
    // } finally {
    //   this.isCreatingEscalation = false
    // }
  }

  async #triggerOpenEscalation(): Promise<boolean | void | undefined> {
    const ctx = getContext()

    if (!this.escalationUrl) {
      return
    }

    return postClientMessage(ctx, ClientMessages.openLink, this.escalationUrl)
  }

  #openSessionOutput(): Promise<void | boolean> | undefined {
    const ctx = getContext()
    if (!ctx.postMessage) {
      return
    }
    return postClientMessage(ctx, ClientMessages.gistCell, {
      cellId: this.id!,
      telemetryEvent: 'app.cellGist',
    })
  }

  /**
   * @param isUserAction Indicates if the user clicked the save button directly
   */
  async #shareCellOutput(_isUserAction: boolean): Promise<boolean | void | undefined> {
    const ctx = getContext()
    if (!ctx.postMessage) {
      return
    }
    // try {
    //   if (this.isUpdatedReady) {
    //     return this.#displayShareDialog()
    //   }
    //   if (this.isShareReady) {
    //     this.isLoading = true
    //     await postClientMessage(ctx, ClientMessages.platformApiRequest, {
    //       data: {
    //         id: this.platformId,
    //       },
    //       id: this.id!,
    //       method: APIMethod.UpdateCellExecution,
    //     })
    //     return
    //   }

    //   this.isLoading = true
    //   const contentWithAnsi =
    //     this.serializer?.serialize({ excludeModes: true, excludeAltBuffer: true }) ?? ''
    //   await postClientMessage(ctx, ClientMessages.platformApiRequest, {
    //     data: {
    //       stdout: contentWithAnsi,
    //       isUserAction,
    //     },
    //     id: this.id!,
    //     method: APIMethod.CreateCellExecution,
    //   })
    // } catch (error) {
    //   this.isLoading = false
    //   postClientMessage(
    //     ctx,
    //     ClientMessages.infoMessage,
    //     `Failed to share output: ${(error as any).message}`,
    //   )
    // }
  }

  #onWebLinkClick(_event: MouseEvent, uri: string): void {
    postClientMessage(getContext(), ClientMessages.openLink, uri)
  }

  #triggerOpenCellOutput(): void {
    postClientMessage(getContext(), ClientMessages.openLink, this.shareUrl!)
  }

  #onEscalateDisabled(): void {
    const message = 'There is no Slack integration configured yet. \nOpen Dashboard to configure it'
    postClientMessage(getContext(), ClientMessages.errorMessage, message)
  }

  // Render the UI as a function of component state
  render() {
    const isSignedIn = false
    const isGistEnabled = true
    const isEscalateEnabled = false

    const buttons = html`
      <close-cell-button
        @closed="${() => {
          return closeOutput({
            id: this.id!,
            outputType: OutputType.terminal,
          })
        }}"
      ></close-cell-button>
      <div class="button-group">
        <copy-button
          copyText="${this.copyText}"
          @onCopy="${async () => {
            return this.#copy()
          }}"
        ></copy-button>
        ${when(
          isGistEnabled,
          () => {
            return html`<gist-cell @onGist="${this.#openSessionOutput}"></gist-cell>`
          },
          () => {},
        )}
        ${when(
          this.shouldRenderSaveButton(),
          () => {
            return html`<save-button
              ?loading=${this.isLoading}
              ?signedIn=${isSignedIn}
              @onClick="${this.#triggerShareCellOutput}"
            >
            </save-button>`
          },
          () => {},
        )}
        ${when(
          this.shouldRenderShareButton(),
          () => {
            return html`<share-button
              ?loading=${this.isLoading}
              @onClick="${this.#triggerShareCellOutput}"
            >
            </share-button>`
          },
          () => {},
        )}
        ${when(
          isEscalateEnabled &&
            this.exitCode !== 0 &&
            !this.escalationUrl &&
            this.platformId &&
            !this.isDaggerOutput,
          () => {
            return html`<action-button
              ?loading=${this.isCreatingEscalation}
              ?saveIcon="${true}"
              text="Escalate"
              @onClick="${this.#triggerEscalation}"
              @onClickDisabled=${this.#onEscalateDisabled}
            >
            </action-button>`
          },
          () => {},
        )}
        ${when(
          isEscalateEnabled && this.escalationUrl,
          () => {
            return html`<action-button
              ?saveIcon="${true}"
              text="Open Escalation"
              @onClick="${this.#triggerOpenEscalation}"
            >
            </action-button>`
          },
          () => {},
        )}
        ${when(
          this.platformId && !this.isLoading,
          () => {
            return html`<open-cell
              ?disabled=${!this.isPlatformAuthEnabled}
              @onOpen="${this.#triggerOpenCellOutput}"
            ></open-cell>`
          },
          () => {},
        )}
      </div>
    `

    return html`<section>
      <div id="terminal"></div>
      ${when(this.buttons, () => buttons)}
    </section>`
  }

  dispose() {
    this.#teardownStreams()
    this.disposables.forEach(({ dispose }) => dispose())
  }

  #copy() {
    const ctx = getContext()
    if (!ctx.postMessage) {
      return
    }
    const content = stripANSI(
      this.serializer?.serialize({ excludeModes: true, excludeAltBuffer: true }) ?? '',
    )
    return navigator.clipboard
      .writeText(content)
      .then(() => {
        this.copyText = 'Copied!'
        this.requestUpdate()
      })
      .catch((err) =>
        postClientMessage(
          ctx,
          ClientMessages.infoMessage,
          `Failed to copy to clipboard: ${err.message}!`,
        ),
      )
  }

  shouldRenderSaveButton() {
    // todo(sebastian): deommissioned for now, remove eventually
    // const isExitCodeValid = this.exitCode === undefined || this.exitCode === 0
    // return !this.platformId && isExitCodeValid && !this.isDaggerOutput
    return false
  }

  shouldRenderShareButton() {
    // todo(sebastian): deommissioned for now, remove eventually
    // const isFeatureEnabled = features.isOn(FeatureName.Share, this.featureState$)
    // return this.platformId && isFeatureEnabled && this.isShareReady
    return false
  }
}

function convertXTermDimensions(dimensions: ITerminalDimensions): TerminalDimensions
function convertXTermDimensions(dimensions: undefined): undefined
function convertXTermDimensions(
  dimensions: ITerminalDimensions | undefined,
): TerminalDimensions | undefined
function convertXTermDimensions(dimensions?: ITerminalDimensions): TerminalDimensions | undefined {
  if (!dimensions) {
    return undefined
  }

  const { rows, cols } = dimensions
  return { columns: cols, rows }
}

function stripANSI(src: string): string {
  return src.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    '',
  )
}
