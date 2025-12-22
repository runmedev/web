import { useEffect } from 'react'

import AppConsole from './AppConsole'

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
      <div id="runme-consoles" />
    </div>
  )
}
