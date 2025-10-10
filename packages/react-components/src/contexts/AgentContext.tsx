import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react'
import { type FC } from 'react'

import * as service_pb from '@buf/runmedev_runme.bufbuild_es/agent/v1/service_pb'
import { Interceptor, createClient } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'

import { useSettings } from './SettingsContext'

export type AgentClient = ReturnType<
  typeof createClient<typeof service_pb.MessagesService>
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
  const { settings, createAuthInterceptors } = useSettings()

  useEffect(() => {
    setClient(
      createAgentClient(settings.agentEndpoint, createAuthInterceptors(true))
    )
  }, [settings.agentEndpoint, createAuthInterceptors])

  return (
    <ClientContext.Provider value={{ client, setClient }}>
      {children}
    </ClientContext.Provider>
  )
}

// CreateAgentClient creates a client to to talk to the backend.
function createAgentClient(
  baseURL: string,
  interceptors: Interceptor[]
): AgentClient {
  console.log(`initializing the client: baseURL ${baseURL}`)
  // We use gRPCWebTransport because we want server side streaming
  const transport = createGrpcWebTransport({
    baseUrl: baseURL,
    interceptors: interceptors,
  })
  // Here we make the client itself, combining the service
  // definition with the transport.
  return createClient(service_pb.MessagesService, transport)
}
