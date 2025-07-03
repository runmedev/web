import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { WebAppConfig } from '@buf/stateful_runme.bufbuild_es/agent/config/webapp_pb'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'

import Actions from './components/Actions/Actions'
import Chat from './components/Chat/Chat'
import FileViewer from './components/Files/Viewer'
import Login from './components/Login/Login'
import NotFound from './components/NotFound'
import Settings from './components/Settings/Settings'
import { AgentClientProvider } from './contexts/AgentContext'
import { BlockProvider } from './contexts/BlockContext'
import { SettingsProvider } from './contexts/SettingsContext'
import './index.css'
import Layout from './layout'

export interface AppBranding {
  name: string
  logo: string
}

export interface AppProps {
  branding: AppBranding
  initialState?: {
    requireAuth?: boolean
    webApp?: WebAppConfig
  }
}

function AppRouter({ branding }: { branding: AppBranding }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <Layout
              branding={branding}
              left={<Chat />}
              middle={<Actions />}
              right={<FileViewer />}
            />
          }
        />
        <Route
          path="/settings"
          element={
            <Layout
              branding={branding}
              left={<Chat />}
              middle={<Actions />}
              right={<Settings />}
            />
          }
        />
        <Route
          path="/oidc/*"
          element={
            <Layout
              branding={branding}
              middle={
                <div>OIDC routes are exclusively handled by the server.</div>
              }
            />
          }
        />
        <Route
          path="/login"
          element={<Layout branding={branding} left={<Login />} />}
        />
        <Route
          path="*"
          element={<Layout branding={branding} left={<NotFound />} />}
        />
      </Routes>
    </BrowserRouter>
  )
}

function App({ branding, initialState = {} }: AppProps) {
  return (
    <>
      <title>{branding.name}</title>
      <meta name="description" content="An AI Assistant For Your Cloud" />
      <link rel="icon" href={branding.logo} />
      <Theme accentColor="gray" scaling="100%" radius="small">
        <SettingsProvider
          requireAuth={initialState?.requireAuth}
          webApp={initialState?.webApp}
        >
          <AgentClientProvider>
            <BlockProvider>
              <AppRouter branding={branding} />
            </BlockProvider>
          </AgentClientProvider>
        </SettingsProvider>
      </Theme>
    </>
  )
}

export default App
