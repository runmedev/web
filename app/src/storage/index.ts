import { clone, create } from "@bufbuild/protobuf";
import { v4 as uuidv4 } from "uuid";

import { parser_pb } from "../runme/client";

type SessionRecord<T> = {
  id: string;
  principal: string;
  name: string;
  created: number;
  updated: number;
  data: T;
};

type SessionNotebook = SessionRecord<parser_pb.Notebook>;

/**
 * Minimal in-memory session storage used to persist notebooks during a browser
 * lifetime. This mirrors the API that runmedev provides so CellContext can
 * operate without depending on that package directly.
 */
export class SessionStorage {
  private readonly sessions = new Map<string, SessionNotebook>();

  constructor(
    private readonly namespace: string,
    readonly principal: string,
    // Runner client is currently unused but kept for signature parity.
    _runnerClient: unknown,
  ) {
    void _runnerClient;
  }

  async saveNotebook(id: string, notebook: parser_pb.Notebook): Promise<void> {
    const now = Date.now();
    const existing = this.sessions.get(id);
    const record: SessionNotebook = {
      id,
      principal: this.principal,
      name: existing?.name ?? generateSessionName(),
      created: existing?.created ?? now,
      updated: now,
      data: clone(parser_pb.NotebookSchema, notebook),
    };
    this.sessions.set(id, record);
  }

  async loadSession(id: string): Promise<SessionNotebook | undefined> {
    const record = this.sessions.get(id);
    if (!record) {
      return undefined;
    }
    return {
      ...record,
      data: clone(parser_pb.NotebookSchema, record.data),
    };
  }

  async loadSessions(ids: string[]): Promise<SessionNotebook[]> {
    const sessions: SessionNotebook[] = [];
    for (const id of ids) {
      const session = await this.loadSession(id);
      if (session) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  async listSessions(): Promise<SessionNotebook[]> {
    return this.loadSessions([...this.sessions.keys()]);
  }

  async listActiveSessions(): Promise<string[]> {
    return [...this.sessions.entries()]
      .sort((a, b) => b[1].updated - a[1].updated)
      .map(([id]) => id);
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async createSession(): Promise<string | undefined> {
    const id = `${this.namespace}-${uuidv4()}`;
    const now = Date.now();
    this.sessions.set(id, {
      id,
      principal: this.principal,
      name: generateSessionName(),
      created: now,
      updated: now,
      data: create(parser_pb.NotebookSchema, {
        cells: [],
        metadata: {},
      }),
    });
    return id;
  }
}

export function generateSessionName(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-");
}

export { ContentsNotebookStore } from "./contents";
export { FsDatabase } from "./fsdb";
export type { WorkspaceRecord, FsEntryRecord } from "./fsdb";
export { FilesystemNotebookStore, isFileSystemAccessSupported } from "./fs";
