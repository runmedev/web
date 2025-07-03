import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react'
import { type FC } from 'react'

import * as blocks_pb from '@buf/stateful_runme.bufbuild_es/agent/blocks_pb'
import { Code, ConnectError, createClient } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'

import { getSessionToken } from '../token'
import { useSettings } from './SettingsContext'

export type AgentClient = ReturnType<
  typeof createClient<typeof blocks_pb.BlocksService>
>

type ClientContextType = {
  client?: AgentClient
  setClient: (client: AgentClient) => void
}

const ClientContext = createContext<ClientContextType | undefined>(undefined)

// eslint-disable-next-line react-refresh/only-export-components
export const useClient = () => {
  const context = useContext(ClientContext)
  if (!context) {
    throw new Error('useClient must be used within a ClientProvider')
  }
  return context
}

// Provider component
export const AgentClientProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [client, setClient] = useState<AgentClient | undefined>()
  const { settings } = useSettings()

  useEffect(() => {
    setClient(createAgentClient(settings.agentEndpoint))
  }, [settings.agentEndpoint])

  return (
    <ClientContext.Provider value={{ client, setClient }}>
      {children}
    </ClientContext.Provider>
  )
}

const redirectOnUnauthError = (error: unknown) => {
  const connectErr = ConnectError.from(error)
  if (connectErr.code === Code.Unauthenticated) {
    window.location.href = `/login?error=${encodeURIComponent(connectErr.name)}&error_description=${encodeURIComponent(connectErr.message)}`
  }
}

// CreateAgentClient creates a client to to talk to the backend.
function createAgentClient(baseURL: string): AgentClient {
  console.log(`initializing the client: baseURL ${baseURL}`)
  // We use gRPCWebTransport because we want server side streaming
  const transport = createGrpcWebTransport({
    baseUrl: baseURL,
    interceptors: [
      (next) => (req) => {
        const token = getSessionToken()
        if (token) {
          req.header.set('Authorization', `Bearer ${token}`)
        }
        return next(req).catch((e) => {
          redirectOnUnauthError(e)
          throw e // allow caller to handle the error
        })
      },
    ],
  })
  // Here we make the client itself, combining the service
  // definition with the transport.
  return createClient(blocks_pb.BlocksService, transport)
}
