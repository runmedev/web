import { create } from '@bufbuild/protobuf'
import {
  ExecuteRequestSchema,
  Winsize,
  WinsizeSchema,
} from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { type RendererContext } from 'vscode-notebook-renderer'
import { type VSCodeEvent } from 'vscode-notebook-renderer/events'

import { ClientMessages } from '../types'

export interface RunmeTransport {
  sendExecuteRequest: (req: any) => void
  setCallback: (cb: VSCodeEvent<any>) => void
}

export interface RunmeRenderContextOptions {
  transport: RunmeTransport
  /**
   * Current window size for the terminal. Passed with terminalOpen if present.
   */
  winsize?: Winsize
  /**
   * Update the cached winsize when a resize arrives.
   */
  onWinsizeChange?: (winsize: Winsize) => void
}

/**
 * A lightweight RenderContext implementation for Runme consoles. It forwards
 * stdin and resize/open events to the provided transport and propagates backend
 * messages via setCallback.
 */
export class RunmeRenderContext implements RendererContext<void> {
  #transport: RunmeTransport
  #winsize?: Winsize
  #onWinsizeChange?: (winsize: Winsize) => void

  constructor(opts: RunmeRenderContextOptions) {
    this.#transport = opts.transport
    this.#winsize = opts.winsize
    this.#onWinsizeChange = opts.onWinsizeChange
  }

  postMessage(message: unknown) {
    if (
      (message as any)?.type === ClientMessages.terminalOpen ||
      (message as any)?.type === ClientMessages.terminalResize
    ) {
      const cols = Number((message as any).output.terminalDimensions.columns)
      const rows = Number((message as any).output.terminalDimensions.rows)
      if (Number.isFinite(cols) && Number.isFinite(rows)) {
        this.#winsize = create(WinsizeSchema, { cols, rows, x: 0, y: 0 })
        this.#onWinsizeChange?.(this.#winsize)
        const req = create(ExecuteRequestSchema, { winsize: this.#winsize })
        this.#transport.sendExecuteRequest(req)
      }
      return
    }

    if ((message as any)?.type === ClientMessages.terminalStdin) {
      const inputData = new TextEncoder().encode((message as any).output.input)
      const req = create(ExecuteRequestSchema, { inputData })
      this.#transport.sendExecuteRequest(req)
    }
  }

  onDidReceiveMessage(listener: VSCodeEvent<any>) {
    this.#transport.setCallback(listener)
    return {
      dispose: () => {
        // no-op; transport manages teardown
      },
    }
  }
}
