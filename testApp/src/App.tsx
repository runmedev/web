import { useEffect } from 'react'

import AppConsole from './AppConsole'
import { Console } from '@runmedev/react-console'
import { FakeStreams } from './fakeStreams'

export default function App() {
  console.log('Rendering App component')

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
        streamCreator={() => new FakeStreams()}
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
        streamCreator={() => new FakeStreams()}
      />
      <div id="runme-consoles" />
    </div>
  )
}
