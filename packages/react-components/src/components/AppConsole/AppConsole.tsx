import { useMemo, useRef } from 'react'

import { ClientMessages, setContext } from '@runmedev/renderers'
import type { RendererContext } from 'vscode-notebook-renderer'
/**
 * AppConsole console panel rendered with Runme's ConsoleView web component.
 *
 * Intended to provide a console for interacting with the app iteself.
 * Right now its just a stub that echoes input.
 */
export default function AppConsole() {
  const elemRef = useRef<any>(null)
  const consoleId = useMemo(
    () => `console-${Math.random().toString(36).substring(2, 9)}`,
    []
  )

  const eventHandler = (eventName: string) => (e: Event) => {
    console.log(eventName, e)
  }

  return (
    <div
      className="w-full h-full"
      ref={(el) => {
        if (!el || el.hasChildNodes()) {
          return
        }
        const elem = document.createElement('console-view') as any

        elemRef.current = elem

        elem.addEventListener('stdout', eventHandler('stdout'))
        elem.addEventListener('stderr', eventHandler('stderr'))
        elem.addEventListener('exitcode', eventHandler('exitcode'))
        elem.addEventListener('pid', eventHandler('pid'))
        elem.addEventListener('mimetype', eventHandler('mimetype'))

        let messageListener: ((message: unknown) => void) | undefined
        let inputBuffer = ''

        setContext({
          postMessage: (message: any) => {
            if (message?.type === ClientMessages.terminalStdin) {
              const input = (message.output?.input as string) ?? ''
              for (const ch of input) {
                if (ch === '\r' || ch === '\n') {
                  const trimmed = inputBuffer.trim()
                  messageListener?.({
                    type: ClientMessages.terminalStdout,
                    output: {
                      'runme.dev/id': consoleId,
                      data: `\r\nGot input: ${trimmed}\r\n> `,
                    },
                  })
                  inputBuffer = ''
                  continue
                }

                // handle backspace/delete
                if (ch === '\u0008' || ch === '\u007f') {
                  inputBuffer = inputBuffer.slice(0, -1)
                  messageListener?.({
                    type: ClientMessages.terminalStdout,
                    output: {
                      'runme.dev/id': consoleId,
                      data: '\b \b',
                    },
                  })
                  continue
                }

                inputBuffer += ch
                messageListener?.({
                  type: ClientMessages.terminalStdout,
                  output: {
                    'runme.dev/id': consoleId,
                    data: ch,
                  },
                })
              }
            }
          },
          onDidReceiveMessage: (listener: (message: unknown) => void) => {
            messageListener = listener
            listener({
              type: ClientMessages.terminalStdout,
              output: {
                'runme.dev/id': consoleId,
                data: 'Welcome to the app console\n> ',
              },
            } as any)
            return {
              dispose: () => {},
            }
          },
        } as RendererContext<void>)

        // Keep the element id in sync with messages dispatched via setContext
        elem.setAttribute('id', consoleId)
        elem.setAttribute('buttons', 'false')
        elem.setAttribute('initialContent', '')
        elem.setAttribute('theme', 'dark')
        elem.setAttribute('fontFamily', 'monospace')
        elem.setAttribute('fontSize', '12')
        elem.setAttribute('cursorStyle', 'block')
        elem.setAttribute('cursorBlink', 'true')
        elem.setAttribute('cursorWidth', '1')
        elem.setAttribute('smoothScrollDuration', '0')
        elem.setAttribute('scrollback', '4000')

        el.appendChild(elem)
      }}
    ></div>
  )
}
