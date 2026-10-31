import Dexie, { type Table } from "dexie";

import { boundedStorage, boundedTransaction } from "../../lib/boundedStorage";
import { getClaimedSessionId } from "../../lib/tabIdentity";
import { registerReleaseDatabase } from "../../releases/databases";
import type {
  PersistedConsoleCellRow,
  PersistedConsoleSessionRow,
} from "./model";

export type LoadedConsoleSession = {
  session: PersistedConsoleSessionRow;
  cells: PersistedConsoleCellRow[];
};

export interface AppConsoleStorageLike {
  createSession(
    now?: string,
    signal?: AbortSignal
  ): Promise<PersistedConsoleSessionRow>;
  loadLatestSession(signal?: AbortSignal): Promise<LoadedConsoleSession | null>;
  saveCells(
    rows: PersistedConsoleCellRow[],
    signal?: AbortSignal
  ): Promise<void>;
  touchSession(
    sessionId: string,
    updatedAt?: string,
    signal?: AbortSignal
  ): Promise<void>;
}

class AppConsoleDatabase extends Dexie implements AppConsoleStorageLike {
  sessions!: Table<PersistedConsoleSessionRow, string>;
  cells!: Table<PersistedConsoleCellRow, string>;

  constructor(databaseName = "runme-app-console") {
    super(databaseName);
    registerReleaseDatabase(this);

    this.version(1).stores({
      sessions: "&id, updatedAt, createdAt",
      cells: "&id, sessionId, [sessionId+index], updatedAt",
    });

    this.sessions = this.table("sessions");
    this.cells = this.table("cells");
  }

  async createSession(
    now = new Date().toISOString(),
    signal?: AbortSignal
  ): Promise<PersistedConsoleSessionRow> {
    const session: PersistedConsoleSessionRow = {
      id: `tab:${await boundedStorage("console.session-claim", () => getClaimedSessionId(), signal)}`,
      createdAt: now,
      updatedAt: now,
    };
    await boundedTransaction(
      this,
      "rw",
      ["sessions"],
      "create-session",
      () => this.sessions.put(session).then(() => {}),
      signal
    );
    return session;
  }

  async loadLatestSession(
    signal?: AbortSignal
  ): Promise<LoadedConsoleSession | null> {
    const id = `tab:${await boundedStorage("console.session-claim", () => getClaimedSessionId(), signal)}`;
    let session = await boundedTransaction(
      this,
      "r",
      ["sessions"],
      "read-session",
      () => this.sessions.get(id),
      signal
    );
    if (!session) {
      // Copy a legacy global console once per tab. Retain its original rows;
      // two tabs must never overwrite each other's unsent console drafts.
      const legacy = await boundedTransaction(
        this,
        "r",
        ["sessions"],
        "find-legacy-session",
        () =>
          this.sessions
            .orderBy("updatedAt")
            .reverse()
            .filter((row) => !row.id.startsWith("tab:"))
            .first(),
        signal
      );
      if (!legacy) return null;
      const original = await boundedTransaction(
        this,
        "r",
        ["cells"],
        "read-legacy-cells",
        () => this.cells.where("sessionId").equals(legacy.id).sortBy("index"),
        signal
      );
      session = { ...legacy, id };
      const cells = original.map((cell) => ({
        ...cell,
        id: crypto.randomUUID(),
        sessionId: id,
      }));
      await boundedTransaction(
        this,
        "rw",
        ["sessions", "cells"],
        "migrate-history",
        async () => {
          await this.sessions.put(session!);
          await this.cells.bulkPut(cells);
        },
        signal
      );
    }
    if (!session) {
      return null;
    }
    const cells = await boundedTransaction(
      this,
      "r",
      ["cells"],
      "read-cells",
      () => this.cells.where("sessionId").equals(session!.id).sortBy("index"),
      signal
    );
    return { session, cells };
  }

  async saveCells(
    rows: PersistedConsoleCellRow[],
    signal?: AbortSignal
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await boundedTransaction(
      this,
      "rw",
      ["cells"],
      "save-cells",
      async () => {
        await this.cells.bulkPut(rows);
      },
      signal
    );
  }

  async touchSession(
    sessionId: string,
    updatedAt = new Date().toISOString(),
    signal?: AbortSignal
  ): Promise<void> {
    await boundedTransaction(
      this,
      "rw",
      ["sessions"],
      "touch-session",
      async () => {
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
      },
      signal
    );
  }
}

export const appConsoleStorage: AppConsoleStorageLike =
  new AppConsoleDatabase();
