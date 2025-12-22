import { useEffect } from 'react'

import AppConsole from './AppConsole'
import { Console } from '@runmedev/react-console'
import { FakeStreams } from './fakeStreams'

export default function App() {
  useEffect(() => {
    // Append two runme-console elements beneath the React root
    const root = document.getElementById('root')
    if (!root) return

    const container = document.createElement('div')
    container.style.display = 'flex'
    container.style.flexDirection = 'column'
    container.style.gap = '16px'

    const labelA = document.createElement('h2')
    labelA.textContent = 'RunmeConsole A'

    const runmeA = document.createElement('runme-console')
    runmeA.setAttribute('id', 'rc-a')
    runmeA.setAttribute('style', 'height:200px; display:block;')
    runmeA.setAttribute('takeFocus', 'true')

    const labelB = document.createElement('h2')
    labelB.textContent = 'RunmeConsole B'

    const runmeB = document.createElement('runme-console')
    runmeB.setAttribute('id', 'rc-b')
    runmeB.setAttribute('style', 'height:200px; display:block;')
    runmeB.setAttribute('takeFocus', 'true')

    container.appendChild(labelA)
    container.appendChild(runmeA)
    container.appendChild(labelB)
    container.appendChild(runmeB)
    root.appendChild(container)

    return () => {
      container.remove()
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <h1>Runme Test App</h1>
      <AppConsole />
      <h2>React Console (A)</h2>
      <Console
        cellID="react-a"
        runID="react-a"
        sequence={0}
        commands={['echo hello from react-a']}
        runner={{
          endpoint: 'ws://localhost:0/fake-a',
          reconnect: false,
          interceptors: [] as any,
        }}
        StreamCreator={() => new FakeStreams()}
      />
      <h2>React Console (B)</h2>
      <Console
        cellID="react-b"
        runID="react-b"
        sequence={0}
        commands={['echo hello from react-b']}
        runner={{
          endpoint: 'ws://localhost:0/fake-b',
          reconnect: false,
          interceptors: [] as any,
        }}
        StreamCreator={() => new FakeStreams()}
      />
      <div id="runme-consoles" />
    </div>
  )
}
