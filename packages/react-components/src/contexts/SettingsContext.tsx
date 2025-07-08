import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { WebAppConfig } from '@buf/stateful_runme.bufbuild_es/agent/v1/webapp_pb'
import {
  Heartbeat,
  StreamError,
  Streams,
  genRunID,
} from '@runmedev/react-console'
import '@runmedev/react-console/react-console.css'
import { Subscription } from 'rxjs'
import { ulid } from 'ulid'

import { getSessionToken } from '../token'

interface Settings {
  agentEndpoint: string
  requireAuth: boolean
  webApp: Required<Omit<WebAppConfig, '$typeName' | '$unknown'>>
}

interface SettingsContextType {
  checkRunnerAuth: () => void
  defaultSettings: Settings
  runnerError: StreamError | null
  settings: Settings
  updateSettings: (newSettings: Partial<Settings>) => void
}

const SettingsContext = createContext<SettingsContextType | undefined>(
  undefined
)

// eslint-disable-next-line react-refresh/only-export-components
export const useSettings = () => {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}

interface SettingsProviderProps {
  children: ReactNode
  requireAuth?: boolean
  webApp?: WebAppConfig
}

export const SettingsProvider = ({
  children,
  requireAuth,
  webApp,
}: SettingsProviderProps) => {
  const [runnerError, setRunnerError] = useState<StreamError | null>(null)

  const defaultSettings: Settings = useMemo(() => {
    const isLocalhost = window.location.hostname === 'localhost'
    const isHttp = window.location.protocol === 'http:'
    const isVite =
      window.location.port === '4173' || window.location.port === '5173'
    const isDev = isLocalhost && isHttp && isVite

    let runnerEndpoint = new URL(window.location.href)
    // Overwrite runner if webApp.runner is provided
    if (webApp?.runner) {
      runnerEndpoint = new URL(webApp.runner)
    }

    const baseSettings: Settings = {
      requireAuth: false,
      agentEndpoint: isDev ? 'http://localhost:8080' : window.location.origin,
      webApp: {
        runner: isDev
          ? 'ws://localhost:8080/ws'
          : `${runnerEndpoint.protocol === 'https:' ? 'wss:' : 'ws:'}//${runnerEndpoint.host}/ws`,
        reconnect: webApp?.reconnect ?? true,
        invertedOrder: webApp?.invertedOrder ?? false,
      },
    }

    // Override requireAuth if provided
    if (requireAuth !== undefined) {
      baseSettings.requireAuth = requireAuth
    }

    return baseSettings
  }, [requireAuth, webApp])

  const [settings, setSettings] = useState<Settings>(() => {
    const savedSettings = localStorage.getItem('cloudAssistantSettings')
    const savedSettingsJson = savedSettings ? JSON.parse(savedSettings) : {}
    // always use the default reconnect value
    if (
      savedSettingsJson &&
      savedSettingsJson.webApp &&
      savedSettingsJson.webApp.reconnect !== undefined
    ) {
      savedSettingsJson.webApp.reconnect = defaultSettings.webApp.reconnect
    }
    const mergedSettings = savedSettings
      ? { ...defaultSettings, ...savedSettingsJson }
      : defaultSettings
    return mergedSettings
  })

  useEffect(() => {
    localStorage.setItem('cloudAssistantSettings', JSON.stringify(settings))
  }, [settings])

  const checkRunnerAuth = useCallback(async () => {
    if (!settings.webApp.runner) {
      return
    }

    // reset runner error
    setRunnerError(null)

    const stream = new Streams(
      { knownID: `check_${ulid()}`, runID: genRunID(), sequence: 0 },
      {
        runnerEndpoint: settings.webApp.runner,
        authorization: {
          bearerToken: getSessionToken(),
        },
        autoReconnect: false, // let it fail, we're interested in the error
      }
    )

    const subs: Subscription[] = []
    subs.push(
      stream.errors.subscribe({
        next: (error) => setRunnerError(error),
      })
    )
    subs.push(
      stream.connect(Heartbeat.INITIAL).subscribe((l) => {
        if (l === null) {
          return
        }
        console.log(
          `Initial heartbeat latency for streamID ${l.streamID} (${l.readyState === 1 ? 'open' : 'closed'}): ${l.latency}ms`
        )
        stream.close()
      })
    )

    return () => {
      subs.forEach((sub) => sub.unsubscribe())
    }
  }, [settings.webApp.runner])

  useEffect(() => {
    checkRunnerAuth()
  }, [checkRunnerAuth])

  const updateSettings = (newSettings: Partial<Settings>) => {
    setSettings((prev) => {
      return {
        ...prev,
        ...newSettings,
        webApp: {
          ...prev.webApp,
          ...newSettings.webApp,
        },
      }
    })
  }

  return (
    <SettingsContext.Provider
      value={{
        checkRunnerAuth,
        defaultSettings,
        runnerError,
        settings,
        updateSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}
