import { createRoot } from 'react-dom/client'

import App, { AppProps } from './App'
import logo from './assets/runme.svg'

// Define the type for the window object with initial state
declare global {
  interface Window {
    __INITIAL_STATE__?: AppProps['initialState']
  }
}

// Read initial state from window object
const initialState = window.__INITIAL_STATE__ || {}

createRoot(document.getElementById('root')!).render(
  <App branding={{ name: 'Runme Agent', logo }} initialState={initialState} />
)
