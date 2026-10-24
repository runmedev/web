import { registerReleaseDatabase } from '../../releases/databases'
import Dexie, { type Table } from "dexie";
import { getClaimedSessionId } from '../../lib/tabIdentity';

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
    registerReleaseDatabase(this)

    this.version(1).stores({
      sessions: "&id, updatedAt, createdAt",
      cells: "&id, sessionId, [sessionId+index], updatedAt",
    });

    this.sessions = this.table("sessions");
    this.cells = this.table("cells");
  }

  async createSession(now = new Date().toISOString()): Promise<PersistedConsoleSessionRow> {
    const session: PersistedConsoleSessionRow = {
      id: `tab:${await getClaimedSessionId()}`,
      createdAt: now,
      updatedAt: now,
    };
    await this.sessions.put(session);
    return session;
  }

  async loadLatestSession(): Promise<LoadedConsoleSession | null> {
    const id = `tab:${await getClaimedSessionId()}`;
    let session = await this.sessions.get(id);
    if (!session) {
      // Copy a legacy global console once per tab. Retain its original rows;
      // two tabs must never overwrite each other's unsent console drafts.
      const legacy = await this.sessions.orderBy('updatedAt').reverse().filter(row => !row.id.startsWith('tab:')).first();
      if (!legacy) return null;
      const original = await this.cells.where('sessionId').equals(legacy.id).sortBy('index');
      session = { ...legacy, id };
      const cells = original.map(cell => ({ ...cell, id: crypto.randomUUID(), sessionId: id }));
      await this.transaction('rw', this.sessions, this.cells, async () => {
        await this.sessions.put(session!);
        await this.cells.bulkPut(cells);
      });
    }
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
