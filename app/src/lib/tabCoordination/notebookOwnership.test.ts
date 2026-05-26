// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const dexieState = vi.hoisted(() => ({
  databases: new Map<string, Map<string, unknown>>(),
}));

vi.mock("dexie", () => {
  class MockDexie {
    private readonly databaseName: string;

    constructor(databaseName: string) {
      this.databaseName = databaseName;
    }

    version() {
      return {
        stores: () => this,
      };
    }

    table() {
      let records = dexieState.databases.get(this.databaseName);
      if (!records) {
        records = new Map<string, unknown>();
        dexieState.databases.set(this.databaseName, records);
      }
      return {
        put: async (record: { notebookUri: string }) => {
          records.set(record.notebookUri, record);
        },
        get: async (notebookUri: string) => records.get(notebookUri),
        delete: async (notebookUri: string) => {
          records.delete(notebookUri);
        },
      };
    }

    close() {}
  }

  return { default: MockDexie };
});

import { NotebookOwnershipManager } from "./notebookOwnership";

type LockCallback = (lock: { name: string } | null) => Promise<unknown> | unknown;

const heldLocks = new Map<string, Promise<unknown>>();

function installFakeWebLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn(
        async (
          name: string,
          options: { ifAvailable?: boolean },
          callback: LockCallback,
        ) => {
          if (heldLocks.has(name) && options.ifAvailable) {
            return callback(null);
          }
          const result = Promise.resolve(callback({ name })).finally(() => {
            heldLocks.delete(name);
          });
          heldLocks.set(name, result);
          return result;
        },
      ),
    },
  });
}

async function flushReleasedLock(): Promise<void> {
  await vi.waitFor(() => {
    expect(heldLocks.size).toBe(0);
  });
}

describe("NotebookOwnershipManager", () => {
  beforeEach(() => {
    dexieState.databases.clear();
    heldLocks.clear();
    installFakeWebLocks();
    document.title = "Runme Test";
    window.history.replaceState(null, "", "/notebooks");
  });

  it("returns unsupported when Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const manager = new NotebookOwnershipManager({
      dbName: "unsupported-test",
      tabId: "tab-a",
    });

    await expect(manager.acquire("local://file/a")).resolves.toEqual({
      status: "unsupported",
      reason: "web_locks_unavailable",
    });

    manager.dispose();
  });

  it("blocks another tab while a notebook lock is held", async () => {
    const first = new NotebookOwnershipManager({
      dbName: "blocked-test",
      tabId: "tab-a",
    });
    const second = new NotebookOwnershipManager({
      dbName: "blocked-test",
      tabId: "tab-b",
    });

    const acquired = await first.acquire("local://file/a");
    expect(acquired.status).toBe("acquired");
    const blocked = await second.acquire("local://file/a");

    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") {
      expect(blocked.owner).toEqual(
        expect.objectContaining({
          notebookUri: "local://file/a",
          ownerTabId: "tab-a",
          ownerLabel: "Runme Test",
        }),
      );
    }

    if (acquired.status === "acquired") {
      acquired.lease.release();
    }
    await flushReleasedLock();
    first.dispose();
    second.dispose();
  });

  it("releases ownership so another tab can acquire the notebook", async () => {
    const first = new NotebookOwnershipManager({
      dbName: "release-test",
      tabId: "tab-a",
    });
    const second = new NotebookOwnershipManager({
      dbName: "release-test",
      tabId: "tab-b",
    });

    const acquired = await first.acquire("local://file/a");
    expect(acquired.status).toBe("acquired");
    if (acquired.status === "acquired") {
      acquired.lease.release();
    }
    await flushReleasedLock();

    const reacquired = await second.acquire("local://file/a");

    expect(reacquired.status).toBe("acquired");
    if (reacquired.status === "acquired") {
      reacquired.lease.release();
    }
    await flushReleasedLock();
    first.dispose();
    second.dispose();
  });

  it("does not report stale same-tab ownership after release starts", async () => {
    const manager = new NotebookOwnershipManager({
      dbName: "stale-release-test",
      tabId: "tab-a",
    });

    const acquired = await manager.acquire("local://file/a");
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      return;
    }

    acquired.lease.release();

    const ownerCheck = acquired.lease.isCurrentOwner();
    const reacquire = manager.acquire("local://file/a");

    await expect(ownerCheck).resolves.toBe(false);
    await expect(reacquire).resolves.toEqual(
      expect.objectContaining({ status: "blocked" }),
    );

    await flushReleasedLock();
    manager.dispose();
  });
});
