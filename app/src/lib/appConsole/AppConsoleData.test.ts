// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type {
  PersistedConsoleCellRow,
  PersistedConsoleSessionRow,
} from "../../components/AppConsole/model";
import { AppConsoleData } from "./AppConsoleData";

function decodeOutputs(rows: Array<{ items?: Array<{ data?: Uint8Array }> }>): string {
  const decoder = new TextDecoder();
  return rows
    .flatMap((row) => row.items ?? [])
    .map((item) => decoder.decode(item?.data ?? new Uint8Array()))
    .join("");
}

function createStorageStub() {
  let session: PersistedConsoleSessionRow | null = null;
  let cells: PersistedConsoleCellRow[] = [];

  return {
    storage: {
      async createSession(now = new Date().toISOString()) {
        session = {
          id: "session-1",
          createdAt: now,
          updatedAt: now,
        };
        return session;
      },
      async loadLatestSession() {
        if (!session) {
          return null;
        }
        return {
          session,
          cells,
        };
      },
      async saveCells(rows: PersistedConsoleCellRow[]) {
        cells = rows.map((row) => ({ ...row }));
      },
      async touchSession(sessionId: string, updatedAt = new Date().toISOString()) {
        session = sessionId
          ? {
              id: sessionId,
              createdAt: session?.createdAt ?? updatedAt,
              updatedAt,
            }
          : null;
      },
    },
    getRows() {
      return cells;
    },
  };
}

describe("AppConsoleData", () => {
  const instances: AppConsoleData[] = [];

  afterEach(() => {
    instances.splice(0).forEach((instance) => instance.dispose());
  });

  it("keeps the current draft while an external execution streams output", async () => {
    const { storage, getRows } = createStorageStub();
    const data = new AppConsoleData({
      storage,
      persistDelayMs: 0,
    });
    instances.push(data);

    await data.hydrate();
    data.setDraftSource("user draft");

    const execution = data.startExternalExecution("console.log('tool')");
    expect(execution).not.toBeNull();

    const runningSnapshot = data.getSnapshot();
    expect(runningSnapshot.cells).toHaveLength(2);
    expect(runningSnapshot.cells[0]?.status).toBe("running");
    expect(runningSnapshot.cells[0]?.source).toBe("console.log('tool')");
    expect(runningSnapshot.cells[1]?.status).toBe("draft");
    expect(runningSnapshot.cells[1]?.source).toBe("user draft");

    data.appendStdout(execution!.cellId, "stdout\n");
    data.appendStderr(execution!.cellId, "stderr\n");
    data.completeExecution(execution!.cellId, { exitCode: 0 });

    const completedSnapshot = data.getSnapshot();
    expect(completedSnapshot.cells).toHaveLength(2);
    expect(completedSnapshot.cells[0]?.status).toBe("success");
    expect(decodeOutputs(completedSnapshot.cells[0]?.outputs ?? [])).toContain("stdout");
    expect(decodeOutputs(completedSnapshot.cells[0]?.outputs ?? [])).toContain("stderr");
    expect(completedSnapshot.cells[1]?.status).toBe("draft");
    expect(completedSnapshot.cells[1]?.source).toBe("user draft");

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getRows()).toHaveLength(2);
  });
});
