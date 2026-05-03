import Dexie, { type Table } from "dexie";

import type {
  PersistedConsoleCellRow,
  PersistedConsoleSessionRow,
} from "./model";

export type LoadedConsoleSession = {
  session: PersistedConsoleSessionRow;
  cells: PersistedConsoleCellRow[];
};

export interface AppConsoleStorageLike {
  createSession(now?: string): Promise<PersistedConsoleSessionRow>;
  loadLatestSession(): Promise<LoadedConsoleSession | null>;
  saveCells(rows: PersistedConsoleCellRow[]): Promise<void>;
  touchSession(sessionId: string, updatedAt?: string): Promise<void>;
}

class AppConsoleDatabase extends Dexie implements AppConsoleStorageLike {
  sessions!: Table<PersistedConsoleSessionRow, string>;
  cells!: Table<PersistedConsoleCellRow, string>;

  constructor(databaseName = "runme-app-console") {
    super(databaseName);

    this.version(1).stores({
      sessions: "&id, updatedAt, createdAt",
      cells: "&id, sessionId, [sessionId+index], updatedAt",
    });

    this.sessions = this.table("sessions");
    this.cells = this.table("cells");
  }

  async createSession(now = new Date().toISOString()): Promise<PersistedConsoleSessionRow> {
    const session: PersistedConsoleSessionRow = {
      id: globalThis.crypto?.randomUUID?.() ?? `app-console-session-${Date.now()}`,
      createdAt: now,
      updatedAt: now,
    };
    await this.sessions.put(session);
    return session;
  }

  async loadLatestSession(): Promise<LoadedConsoleSession | null> {
    const session = await this.sessions.orderBy("updatedAt").last();
    if (!session) {
      return null;
    }
    const cells = await this.cells
      .where("sessionId")
      .equals(session.id)
      .sortBy("index");
    return { session, cells };
  }

  async saveCells(rows: PersistedConsoleCellRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.transaction("rw", this.cells, async () => {
      await this.cells.bulkPut(rows);
    });
  }

  async touchSession(
    sessionId: string,
    updatedAt = new Date().toISOString(),
  ): Promise<void> {
    const existing = await this.sessions.get(sessionId);
    if (!existing) {
      await this.sessions.put({
        id: sessionId,
        createdAt: updatedAt,
        updatedAt,
      });
      return;
    }
    await this.sessions.put({
      ...existing,
      updatedAt,
    });
  }
}

export const appConsoleStorage: AppConsoleStorageLike = new AppConsoleDatabase();
