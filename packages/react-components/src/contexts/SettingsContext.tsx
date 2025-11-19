import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { WebAppConfig } from '@buf/runmedev_runme.bufbuild_es/agent/v1/webapp_pb'
import { Code, ConnectError, Interceptor } from '@connectrpc/connect'
import {
  Heartbeat,
  StreamError,
  Streams,
  genRunID,
} from '@runmedev/react-console'
import { JwtPayload, jwtDecode } from 'jwt-decode'
import { Subscription } from 'rxjs'
import { ulid } from 'ulid'

import { getSessionToken } from '../token'

interface Settings {
  agentEndpoint: string
  systemShell?: string
  requireAuth: boolean
  webApp: Required<Omit<WebAppConfig, '$typeName' | '$unknown'>>
}

interface SettingsContextType {
  principal: string
  checkRunnerAuth: () => void
  createAuthInterceptors: (redirect: boolean) => Interceptor[]
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
  agentEndpoint?: string
  systemShell?: string
  requireAuth?: boolean
  webApp?: Partial<Omit<WebAppConfig, '$typeName' | '$unknown'>>
  /** If provided, this replaces the default implementation entirely */
  createAuthInterceptors?: (redirect: boolean) => Interceptor[]
}

export const SettingsProvider = ({
  children,
  agentEndpoint,
  systemShell,
  requireAuth,
  webApp,
  createAuthInterceptors,
}: SettingsProviderProps) => {
  const [runnerError, setRunnerError] = useState<StreamError | null>(null)

  const principal = useMemo(() => {
    const token = getSessionToken()
    if (!token) {
      return 'unauthenticated'
    }
    let decodedToken: JwtPayload & { email?: string }
    try {
      decodedToken = jwtDecode(token)
      return decodedToken.email || decodedToken.sub || 'unauthenticated'
    } catch (e) {
      console.error('Error decoding token', e)
      return 'unauthenticated'
    }
  }, [])

  const defaultSettings: Settings = useMemo(() => {
    const isLocalhost = window.location.hostname === 'localhost'
    const isHttp = window.location.protocol === 'http:'
    const isVite =
      window.location.port === '4173' ||
      window.location.port === '5173' ||
      window.location.port === '4321'
    const isDev = isLocalhost && isHttp && isVite

    const baseSettings: Settings = {
      requireAuth: requireAuth ?? false,
      agentEndpoint:
        agentEndpoint ||
        (isDev ? 'http://localhost:8080' : window.location.origin),
      systemShell: systemShell,
      webApp: {
        runner:
          webApp?.runner ||
          (isDev
            ? 'ws://localhost:8080/ws'
            : `${isHttp ? 'ws:' : 'wss:'}//${window.location.host}/ws`),
        reconnect: webApp?.reconnect ?? true,
        invertedOrder: webApp?.invertedOrder ?? false,
      },
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

  // defaultCreateAuthInterceptors default interceptors
  const defaultCreateAuthInterceptors = useCallback(
    (redirect: boolean): Interceptor[] => {
      const redirectOnUnauthError = (error: unknown) => {
        const currentPath = window.location.pathname
        const connectErr = ConnectError.from(error)
        if (
          currentPath !== '/login' &&
          connectErr.code === Code.Unauthenticated
        ) {
          window.location.href = `/login?error=${encodeURIComponent(connectErr.name)}&error_description=${encodeURIComponent(connectErr.message)}`
        }
      }
      return [
        (next) => async (req) => {
          // Single place to change where tokens are coming from
          const token = getSessionToken()
          if (token) {
            req.header.set('Authorization', `Bearer ${token}`)
          }
          if (redirect) {
            return next(req).catch((e) => {
              redirectOnUnauthError(e)
              throw e
            })
          }
          return next(req)
        },
      ]
    },
    []
  )

  const actualCreateAuthInterceptors = useMemo(
    () => createAuthInterceptors ?? defaultCreateAuthInterceptors,
    [createAuthInterceptors, defaultCreateAuthInterceptors]
  )

  const checkRunnerAuth = useCallback(async () => {
    if (!settings.webApp.runner) {
      return
    }

    // reset runner error
    setRunnerError(null)

    const stream = new Streams({
      knownID: `check_${ulid()}`,
      runID: genRunID(),
      sequence: 0,
      options: {
        runnerEndpoint: settings.webApp.runner,
        interceptors: actualCreateAuthInterceptors(false),
        autoReconnect: false, // let it fail, the user is interested in the error
      },
    })

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
  }, [createAuthInterceptors, settings.webApp.runner])

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
        principal,
        checkRunnerAuth,
        createAuthInterceptors: actualCreateAuthInterceptors,
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
