// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PersistedConsoleCellRow,
  PersistedConsoleSessionRow,
} from "../../components/AppConsole/model";
import { AppConsoleData } from "./AppConsoleData";

function decodeOutputs(
  rows: Array<{ items?: Array<{ data?: Uint8Array }> }>
): string {
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
      async touchSession(
        sessionId: string,
        updatedAt = new Date().toISOString()
      ) {
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
    expect(decodeOutputs(completedSnapshot.cells[0]?.outputs ?? [])).toContain(
      "stdout"
    );
    expect(decodeOutputs(completedSnapshot.cells[0]?.outputs ?? [])).toContain(
      "stderr"
    );
    expect(completedSnapshot.cells[1]?.status).toBe("draft");
    expect(completedSnapshot.cells[1]?.source).toBe("user draft");

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getRows()).toHaveLength(2);
  });
});

it("waits for draft persistence and retains the draft when saving fails", async () => {
  const { storage, getRows } = createStorageStub();
  const data = new AppConsoleData({ storage, persistDelayMs: 60000 });
  try {
    await data.hydrate();
    data.setDraftSource("unsent private draft");
    const save = vi
      .spyOn(storage, "saveCells")
      .mockRejectedValueOnce(new Error("quota"));
    await expect(data.flushForRelease()).rejects.toThrow("quota");
    data.setDraftSource("recovered draft");
    await data.flushForRelease();
    expect(save).toHaveBeenCalledTimes(2);
    expect(getRows().some((row) => row.source === "recovered draft")).toBe(
      true
    );
    expect(() => data.startExternalExecution("new operation")).toThrow(
      "frozen"
    );
    data.resumeAfterFailedPreparation();
    data.setDraftSource("still editable");
  } finally {
    data.dispose();
  }
});

it("runs without history and ignores a late read without overwriting the live draft", async () => {
  const { storage } = createStorageStub();
  let finish!: (value: any) => void;
  storage.loadLatestSession = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<typeof storage.loadLatestSession>>>(
        (resolve) => {
          finish = resolve;
        }
      )
  );
  const save = vi.spyOn(storage, "saveCells");
  const create = vi.spyOn(storage, "createSession");
  const data = new AppConsoleData({ storage, persistDelayMs: 0 });
  const pending = data.hydrate();
  await Promise.resolve();
  data.setDraftSource("keep this unsent draft");
  const execution = data.startExternalExecution("console.log('health-check')")!;
  data.appendStdout(execution.cellId, "health-check\n");
  data.completeExecution(execution.cellId, { exitCode: 0 });
  finish(null);
  await pending;
  expect(data.getSnapshot().hydrated).toBe(true);
  expect(data.getSnapshot().loadError).toContain("only in this tab");
  expect(data.getSnapshot().cells.at(-1)?.source).toBe(
    "keep this unsent draft"
  );
  expect(decodeOutputs(data.getSnapshot().cells[0].outputs)).toContain(
    "health-check"
  );
  expect(save).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  await expect(data.flushForRelease()).rejects.toThrow("cannot be saved");
  data.dispose();
});

it("bounds hydration even when storage never responds, retaining an editable console", async () => {
  vi.useFakeTimers();
  const { storage } = createStorageStub();
  storage.loadLatestSession = () => new Promise(() => {});
  const data = new AppConsoleData({ storage });
  try {
    const pending = data.hydrate();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(data.getSnapshot().hydrated).toBe(true);
    data.setDraftSource("still editable");
    expect(data.startDraftExecution()?.source).toBe("still editable");
  } finally {
    data.dispose();
    vi.useRealTimers();
  }
});

it("records fast external commands after healthy history and drains them before reload", async () => {
  const { storage, getRows } = createStorageStub();
  const original = new AppConsoleData({ storage });
  await original.hydrate();
  original.setDraftSource("saved draft");
  await original.flushForRelease();
  original.dispose();
  const saved = await storage.loadLatestSession();
  let finish!: (value: typeof saved) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  vi.spyOn(storage, "loadLatestSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        markStarted();
      })
  );
  const data = new AppConsoleData({ storage });
  let execution: ReturnType<AppConsoleData["startExternalExecution"]> = null;
  data.queueHistoryUpdate(() => {
    execution = data.startExternalExecution("health-check");
  });
  data.queueHistoryUpdate(() => {
    data.appendStdout(execution!.cellId, "done\n");
  });
  data.queueHistoryUpdate(() => {
    data.completeExecution(execution!.cellId, { exitCode: 0 });
  });
  const flush = data.flushForRelease();
  try {
    await started;
    finish(saved);
    await flush;
    expect(data.getSnapshot().loadError).toBeNull();
    expect(
      data.getSnapshot().cells.find((cell) => cell.status === "draft")?.source
    ).toBe("saved draft");
    expect(getRows().find((row) => row.source === "health-check")?.status).toBe(
      "success"
    );
  } finally {
    data.dispose();
  }
});
