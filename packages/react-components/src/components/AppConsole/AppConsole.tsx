import { useMemo, useRef } from 'react'

import { ClientMessages, setContext } from '@runmedev/renderers'
import type { RendererContext } from 'vscode-notebook-renderer'
/**
 * AppConsole console panel rendered with Runme's ConsoleView web component.
 *
 * @runmedev/react-console (imported at app entry) registers the custom
 * elements (console-view, close-cell-button, etc.) as a side effect, so
 * by the time this renders the elements should already be defined.
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

        setContext({
          postMessage: (message: unknown) => {
            // Only need this if, e.g., we received stdin
            console.log('message', message)
          },
          onDidReceiveMessage: (listener: (message: unknown) => void) => {
            listener({
              type: ClientMessages.terminalStdout,
              output: {
                'runme.dev/id': consoleId,
                data: 'Welcome to the Runme console\n',
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
        elem.setAttribute('initialContent', 'Welcome to the Runme console\r\n')
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

// let context: RendererContext<void> | undefined

// export function setContext(c: RendererContext<void>) {
//   context = c
// }
