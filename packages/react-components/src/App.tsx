import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { InitialConfigState } from '@buf/runmedev_runme.bufbuild_es/agent/v1/webapp_pb'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'

import Actions from './components/Actions/Actions'
import Chat, { ChatSequence } from './components/Chat/Chat'
import FileViewer from './components/Files/Viewer'
import Login from './components/Login/Login'
import Settings from './components/Settings/Settings'
import { AgentClientProvider } from './contexts/AgentContext'
import { CellProvider } from './contexts/CellContext'
import { OutputProvider } from './contexts/OutputContext'
import { SettingsProvider } from './contexts/SettingsContext'
import './index.css'
import Layout from './layout'
import { getAccessToken } from './token'
import { NotFound } from './components'

export interface AppBranding {
  name: string
  logo: string
}

export interface AppProps {
  branding: AppBranding
  initialState?: Partial<
    Omit<InitialConfigState, '$typeName' | '$unknown' | 'webApp'>
  > & {
    webApp?: Partial<
      Omit<InitialConfigState['webApp'], '$typeName' | '$unknown'>
    >
  }
}

function AppRoutes({ branding }: { branding: AppBranding }) {
  const actions = <Actions headline="Actions" />
  const files = <FileViewer headline="Files" />
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Layout
            branding={branding}
            left={<Chat />}
            middle={actions}
            right={files}
          />
        }
      />
      <Route
        path="/settings"
        element={
          <Layout
            branding={branding}
            left={<Chat />}
            middle={actions}
            right={<Settings />}
          />
        }
      />
      <Route path="/sequence">
        <Route index element={<ChatSequence />} />
      </Route>
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
  )
}

export function AppProviders({ branding, initialState = {} }: AppProps) {
  return (
    <>
      <title>{branding.name}</title>
      <meta name="description" content="An AI Assistant For Your Cloud" />
      <link rel="icon" href={branding.logo} />
      <Theme
        appearance="light"
        accentColor="violet"
        scaling="100%"
        radius="small"
      >
        <SettingsProvider
          agentEndpoint={initialState?.agentEndpoint}
          systemShell={initialState?.systemShell}
          requireAuth={initialState?.requireAuth}
          webApp={initialState?.webApp}
        >
          <AgentClientProvider>
            <OutputProvider>
              <CellProvider getAccessToken={getAccessToken}>
                <AppRoutes branding={branding} />
              </CellProvider>
            </OutputProvider>
          </AgentClientProvider>
        </SettingsProvider>
      </Theme>
    </>
  )
}

function App({ branding, initialState = {} }: AppProps) {
  return (
    <BrowserRouter>
      <AppProviders branding={branding} initialState={initialState} />
    </BrowserRouter>
  )
}

export default App
