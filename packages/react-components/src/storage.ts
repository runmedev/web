import { Notebook } from '@buf/runmedev_runme.bufbuild_es/runme/parser/v1/parser_pb'
import {
  GetSessionRequestSchema,
  GetSessionResponse,
} from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import Dexie, { Table } from 'dexie'
import { Subject } from 'rxjs'
import { debounceTime } from 'rxjs/operators'

import { RunnerClient } from './runme/client'

export interface SessionRecord<T> {
  id: string // session ulid
  principal: string // e.g. email of the user
  name: string
  created: number
  updated: number
  data: T // JSON blob (e.g. cells, notebook, etc.)
}

export type SessionNotebook = SessionRecord<Notebook>

/**
 * Storage interface for session persistence.
 * Implementations can use IndexedDB (Dexie), Supabase Postgres, or other backends.
 */
export interface ISessionStorage {
  /** The owner/user identifier, used for scoping queries and RLS */
  readonly principal: string

  /** Save or update a notebook for a session */
  saveNotebook(id: string, notebook: Notebook): Promise<void> | void

  /** Load a single session by id */
  loadSession(id: string): Promise<SessionNotebook | undefined>

  /** Load multiple sessions by their ids */
  loadSessions(ids: string[]): Promise<SessionNotebook[]>

  /** List all sessions for the principal (sorted by updated desc) */
  listSessions(): Promise<SessionNotebook[]>

  /** List session ids that are still active (created in last 24 hours and valid) */
  listActiveSessions(): Promise<string[]>

  /** Delete a session by id */
  deleteSession(id: string): Promise<void>
}

export class DexieSessionStorage extends Dexie implements ISessionStorage {
  sessions!: Table<SessionNotebook, string>
  readonly principal: string
  readonly client: RunnerClient

  private saveSubject = new Subject<{ id: string; notebook: Notebook }>()

  constructor(namespace: string, principal: string, client: RunnerClient) {
    super(namespace)
    this.principal = principal
    this.client = client
    this.version(1).stores({
      sessions: 'id, principal, name, created, updated',
    })

    // Debounce saves to avoid excessive writes
    this.saveSubject
      .pipe(debounceTime(200))
      .subscribe(async ({ id, notebook }) => {
        if (!id) {
          console.warn(new Date().toISOString(), 'no id to save notebook')
          return
        }
        const record: SessionNotebook = {
          id,
          principal: this.principal,
          name: generateSessionName(),
          created: Date.now(),
          updated: Date.now(),
          data: notebook,
        }
        // console.log(new Date().toISOString(), 'saving Notebook', id, notebook)
        await this.sessions.put(record)
      })
  }

  // Save or update a session
  async saveNotebook(id: string, notebook: Notebook) {
    // console.log(
    //   new Date().toISOString(),
    //   'scheduling Notebook save',
    //   id,
    //   notebook
    // )
    // schedule a save to allow debouncing to avoid excessive writes
    this.saveSubject.next({ id, notebook })
  }

  // Load a session by id
  async loadSession(id: string): Promise<SessionNotebook | undefined> {
    return this.sessions.get(id)
  }

  // Load sessions by an array of ids
  async loadSessions(ids: string[]): Promise<SessionNotebook[]> {
    const sessions = await this.sessions.bulkGet(ids)
    return sessions.filter((s) => !!s) as SessionNotebook[]
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
}

export function generateSessionName(): string {
  return new Date().toISOString()
}

/** @deprecated Use DexieSessionStorage directly. Alias for backwards compatibility. */
export { DexieSessionStorage as SessionStorage }
