import { useEffect, useMemo, useRef } from 'react'

import type { RendererContext } from 'vscode-notebook-renderer'
import type { VSCodeEvent } from 'vscode-notebook-renderer/events'

import '@runmedev/react-console'
import { ClientMessages } from '@runmedev/renderers'

class FakeContext implements RendererContext<void> {
  #id: string
  #listener?: VSCodeEvent<any>

  constructor(id: string, welcome: string) {
    this.#id = id
    this.#listener = undefined
    // seed once listener is attached
    this.#seed = welcome
  }

  #seed: string

  postMessage(message: unknown) {
    const m = message as any
    if (m?.type === ClientMessages.terminalStdin) {
      const input = (m.output?.input as string) ?? ''
      this.#listener?.({
        type: ClientMessages.terminalStdout,
        output: {
          'runme.dev/id': this.#id,
          data: `\r\n[${this.#id}] got: ${input.trim()}\r\n> `,
        },
      } as any)
    }
  }

  onDidReceiveMessage(cb: VSCodeEvent<any>) {
    this.#listener = cb
    cb({
      type: ClientMessages.terminalStdout,
      output: {
        'runme.dev/id': this.#id,
        data: this.#seed,
      },
    } as any)
    return { dispose: () => (this.#listener = undefined) }
  }
}

function ConsoleViewWithContext({ id, ctx }: { id: string; ctx: RendererContext<void> }) {
  const ref = useRef<any>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.context = ctx
    }
  }, [ctx])

  return (
    <div className="border p-2 mb-2">
      <console-view
        ref={ref}
        id={id}
        buttons="false"
        theme="dark"
        style={{ height: '200px', display: 'block' } as any}
      ></console-view>
    </div>
  )
}

function RunmeConsoleWithContext({
  id,
  ctx,
}: {
  id: string
  ctx: RendererContext<void>
}) {
  const ref = useRef<any>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.context = ctx
    }
  }, [ctx])

  return (
    <div className="border p-2 mb-2">
      <runme-console
        ref={ref}
        id={id}
        style={{ height: '200px', display: 'block' } as any}
        takeFocus="true"
      ></runme-console>
    </div>
  )
}

export default function App() {
  const ctxA = useMemo(
    () => new FakeContext('backend-a', 'Welcome backend-a\r\n> '),
    []
  )
  const ctxB = useMemo(
    () => new FakeContext('backend-b', 'Welcome backend-b\r\n> '),
    []
  )
  const ctxC = useMemo(
    () => new FakeContext('backend-c', 'Welcome backend-c\r\n> '),
    []
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <h2>RunmeConsole A (backend-a)</h2>
      <RunmeConsoleWithContext id="rc-a" ctx={ctxA} />

      <h2>RunmeConsole B (backend-b)</h2>
      <RunmeConsoleWithContext id="rc-b" ctx={ctxB} />

      <h2>ConsoleView (backend-c)</h2>
      <ConsoleViewWithContext id="console-view-1" ctx={ctxC} />
    </div>
  )
}
