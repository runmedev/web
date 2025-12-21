import { useRef } from 'react'
import {
  ClientMessages,
  removeContext,
  setContext,
  type RendererContext,
} from '@runmedev/renderers'
import '@runmedev/renderers'

function DemoConsole({ consoleID }: { consoleID: string }) {
  const elemRef = useRef<any>(null)

  const eventHandler = (eventName: string) => (e: Event) => {
    console.log(eventName, e)
  }

  let inputBuffer = ''
  let messageListener: ((message: unknown) => void) | undefined

  return (
    <div
      ref={(el) => {
        if (!el || el.hasChildNodes()) {
          return
        }

        const ctxBridge = {
          postMessage: (message: any) => {
            if (message?.type === ClientMessages.terminalStdin) {
              const input = (message.output?.input as string) ?? ''
              for (const ch of input) {
                if (ch === '\r' || ch === '\n') {
                  const trimmed = inputBuffer.trim()
                  messageListener?.({
                    type: ClientMessages.terminalStdout,
                    output: {
                      'runme.dev/id': consoleID,
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
                      'runme.dev/id': consoleID,
                      data: '\b \b',
                    },
                  })
                  continue
                }

                inputBuffer += ch
                messageListener?.({
                  type: ClientMessages.terminalStdout,
                  output: {
                    'runme.dev/id': consoleID,
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
                'runme.dev/id': consoleID,
                data: 'Welcome to the app console\n> ',
              },
            } as any)
            return {
              dispose: () => {},
            }
          },
        } as RendererContext<void>
        setContext(ctxBridge, consoleID)

        const elem = document.createElement('console-view')
        elemRef.current = elem

        elem.addEventListener('stdout', eventHandler('stdout'))
        elem.addEventListener('stderr', eventHandler('stderr'))
        elem.addEventListener('exitcode', eventHandler('exitcode'))
        elem.addEventListener('pid', eventHandler('pid'))
        elem.addEventListener('mimetype', eventHandler('mimetype'))

        elem.setAttribute('id', consoleID)
        elem.setAttribute('takeFocus', 'false')
        elem.setAttribute('buttons', 'false')
        elem.setAttribute('initialContent', 'Hello, world!\n')
        elem.setAttribute('theme', 'dark')
        elem.setAttribute('fontFamily', 'monospace')
        elem.setAttribute('fontSize', '12')
        elem.setAttribute('cursorStyle', 'block')
        elem.setAttribute('cursorBlink', 'true')
        elem.setAttribute('cursorWidth', '1')
        elem.setAttribute('smoothScrollDuration', '0')
        elem.setAttribute('scrollback', '4000')

        el.appendChild(elem)

        return () => {
          removeContext(consoleID)
        }
      }}
    ></div>
  )
}

export default DemoConsole
