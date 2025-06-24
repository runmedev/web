import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'

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
import { SettingsProvider, useSettings } from './contexts/SettingsContext'
import { WebAppConfig } from '@buf/stateful_runme.bufbuild_es/agent/config/webapp_pb'
import { Code } from '@buf/googleapis_googleapis.bufbuild_es/google/rpc/code_pb'
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
  const { settings, runnerError } = useSettings()

  useEffect(() => {
    if (!runnerError) {
      return
    }

    const settingsPath = '/settings'
    const currentPath = window.location.pathname
    if (
      currentPath === settingsPath ||
      currentPath === '/login' ||
      currentPath === '/oidc/login'
    ) {
      return
    }

    const loginUrl = settings.requireAuth ? '/oidc/login' : '/login'

    if (!(runnerError instanceof Error) && !(runnerError instanceof Event)) {
      const isAuthError =
        runnerError.code === Code.UNAUTHENTICATED ||
        runnerError.code === Code.PERMISSION_DENIED
      const redirectUrl = isAuthError ? loginUrl : settingsPath
      window.location.href = redirectUrl
      return
    }

    window.location.href = settingsPath
  }, [runnerError, settings.requireAuth])

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
        <Route path="*" element={<Layout branding={branding} left={<NotFound />} />} />
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
