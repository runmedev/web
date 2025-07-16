import { Notebook } from '@buf/stateful_runme.bufbuild_es/runme/parser/v1/parser_pb'
import {
  CreateSessionRequest_Config_SessionEnvStoreSeeding,
  GetSessionRequestSchema,
  GetSessionResponse,
  ProjectSchema,
  RunnerService,
} from '@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { DescService, create } from '@bufbuild/protobuf'
import { createClient } from '@connectrpc/connect'
import { Code, ConnectError } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'
import Dexie, { Table } from 'dexie'

import { getSessionToken } from './token'

export function createGrpcClient<T extends DescService>(
  service: T,
  baseURL: string
) {
  const transport = createGrpcWebTransport({
    baseUrl: baseURL,
    interceptors: [
      (next) => (req) => {
        const token = getSessionToken()
        if (token) {
          req.header.set('Authorization', `Bearer ${token}`)
        }
        return next(req).catch((e) => {
          throw e // allow caller to handle the error
        })
      },
    ],
  })
  return createClient(service, transport)
}

export type RunnerClient = ReturnType<typeof createClient<typeof RunnerService>>

export interface SessionRecord<T> {
  id: string // session ulid
  principal: string // e.g. email of the user
  name: string
  created: number
  updated: number
  data: T // JSON blob (e.g. cells, notebook, etc.)
}

export type SessionNotebook = SessionRecord<Notebook>

export class SessionStorage extends Dexie {
  sessions!: Table<SessionNotebook, string>
  readonly principal: string
  readonly client: RunnerClient

  constructor(namespace: string, principal: string, client: RunnerClient) {
    super(namespace)
    this.principal = principal
    this.client = client
    this.version(1).stores({
      sessions: 'id, principal, name, created, updated',
    })
  }

  // Save or update a session
  async saveNotebook(id: string, notebook: Notebook) {
    const record: SessionNotebook = {
      id,
      principal: this.principal,
      name: 'Untitled',
      created: Date.now(),
      updated: Date.now(),
      data: notebook,
    }
    await this.sessions.put(record)
  }

  // Load a session by id
  async loadSession(id: string): Promise<SessionNotebook | undefined> {
    return this.sessions.get(id)
  }

  // List all sessions (sorted by updated desc)
  async listSessions(): Promise<SessionNotebook[]> {
    return this.sessions.orderBy('updated').reverse().toArray()
  }

  private query() {
    return this.sessions.where('principal').equals(this.principal)
  }

  // Get session created in the last 24 hours if still active
  async listActiveSessions(): Promise<string[]> {
    const now = Date.now()
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000
    const candidates = await this.query()
      .and((session) => session.updated >= twentyFourHoursAgo)
      .and((session) => session.updated <= now)
      .reverse()
      .primaryKeys()

    let resps: (GetSessionResponse | undefined)[] = []
    try {
      resps = await Promise.all(
        candidates.map((id) =>
          this.client
            .getSession(create(GetSessionRequestSchema, { id }))
            .catch((e) => {
              const connectErr = ConnectError.from(e)
              if (
                connectErr.code === Code.Unknown &&
                connectErr.message.includes('session not found')
              ) {
                return undefined
              }
              throw e
            })
        )
      )
    } catch (e) {
      console.error('Error listing active sessions', e)
      return []
    }

    const activeSessions = resps
      .map((r) => r?.session?.id)
      .filter((id) => !!id) as string[]
    return activeSessions
  }

  // Delete a session by id
  async deleteSession(id: string) {
    await this.sessions.delete(id)
  }

  async createSession(): Promise<string | undefined> {
    try {
      const resp = await this.client.createSession({
        project: create(ProjectSchema, {
          root: '.',
          envLoadOrder: ['.env', '.env.local', '.env.development', '.env.dev'],
        }),
        config: {
          envStoreSeeding:
            CreateSessionRequest_Config_SessionEnvStoreSeeding.SYSTEM,
        },
      })
      return resp.session?.id ?? ''
    } catch (e) {
      console.error('Error creating session', e)
      return undefined
    }
  }
}
