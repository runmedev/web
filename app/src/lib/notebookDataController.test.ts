import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parser_pb } from "../contexts/CellContext";
import type { LocalNotebooks } from "../storage/local";
import type {
  AcquireResult,
  NotebookOwnershipManager,
} from "./tabCoordination/notebookOwnership";
import { NotebookStoreItemType } from "../storage/notebook";
import {
  __resetNotebookDataControllerForTests,
  getNotebookDataController,
} from "./notebookDataController";

vi.mock("@runmedev/renderers", () => ({
  Streams: class {},
  Heartbeat: { INITIAL: "INITIAL" },
  genRunID: () => "run-generated",
}));

function createNotebook(value = ""): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    cells: value
      ? [
          create(parser_pb.CellSchema, {
            refId: "cell-1",
            value,
          }),
        ]
      : [],
    metadata: {},
  });
}

function createFakeLocalNotebooks() {
  const records = new Map<
    string,
    {
      id: string;
      name: string;
      remoteId: string;
      notebook: parser_pb.Notebook;
    }
  >();
  let nextId = 1;

  return {
    records,
    addFile: vi.fn(async (remoteUri: string, name?: string) => {
      for (const record of records.values()) {
        if (record.remoteId === remoteUri) {
          if (name) {
            record.name = name;
          }
          return record.id;
        }
      }
      const id = `local://file/${nextId++}`;
      records.set(id, {
        id,
        name: name ?? remoteUri,
        remoteId: remoteUri,
        notebook: createNotebook(),
      });
      return id;
    }),
    getMetadata: vi.fn(async (uri: string) => {
      const record = records.get(uri);
      if (!record) {
        return null;
      }
      return {
        uri: record.id,
        name: record.name,
        type: NotebookStoreItemType.File,
        children: [],
        parents: [],
        remoteUri:
          record.remoteId === record.id ? undefined : record.remoteId,
      };
    }),
    load: vi.fn(async (uri: string) => {
      const record = records.get(uri);
      if (!record) {
        throw new Error(`Local notebook record not found for ${uri}`);
      }
      return record.notebook;
    }),
    save: vi.fn(),
  };
}

function createFakeOwnershipManager(
  acquireResult?: AcquireResult,
): NotebookOwnershipManager {
  const fallbackLease = {
    notebookUri: "local://file/demo",
    tabId: "tab-test",
    epoch: "epoch-test",
    release: vi.fn(),
    isCurrentOwner: vi.fn(async () => true),
  };
  return {
    acquire: vi.fn(async (notebookUri: string) => {
      if (acquireResult) {
        return acquireResult;
      }
      return {
        status: "acquired",
        lease: {
          ...fallbackLease,
          notebookUri,
        },
      };
    }),
    release: vi.fn(),
    getOwner: vi.fn(async () => null),
    subscribe: vi.fn(() => () => {}),
    isCurrentOwner: vi.fn(async () => true),
    dispose: vi.fn(),
  } as unknown as NotebookOwnershipManager;
}

describe("NotebookDataController", () => {
  beforeEach(() => {
    __resetNotebookDataControllerForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("opens a local notebook and loads NotebookData", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/demo", {
      id: "local://file/demo",
      name: "demo.json",
      remoteId: "local://file/demo",
      notebook: createNotebook("console.log('demo')"),
    });

    const controller = getNotebookDataController();
    controller.configureOwnershipManager(createFakeOwnershipManager());
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });

    const result = await controller.openNotebook("local://file/demo");

    expect(result.localUri).toBe("local://file/demo");
    expect(controller.getOpenNotebooks()).toEqual([
      expect.objectContaining({
        uri: "local://file/demo",
        requestedUri: "local://file/demo",
        name: "demo.json",
        state: "loaded",
      }),
    ]);
    expect(controller.getNotebookData("local://file/demo")?.getSnapshot()).toEqual(
      expect.objectContaining({
        uri: "local://file/demo",
        name: "demo.json",
        loaded: true,
      }),
    );
  });

  it("resolves a remote URI to a stable local URI before loading", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/existing", {
      id: "local://file/existing",
      name: "existing.json",
      remoteId: "fs://workspace/demo/file/existing.json",
      notebook: createNotebook("console.log('existing')"),
    });
    const controller = getNotebookDataController();
    controller.configureOwnershipManager(createFakeOwnershipManager());
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });

    const result = await controller.openNotebook(
      "fs://workspace/demo/file/existing.json",
      { name: "renamed.json" },
    );

    expect(localStore.addFile).toHaveBeenCalledWith(
      "fs://workspace/demo/file/existing.json",
      "renamed.json",
    );
    expect(result.localUri).toBe("local://file/existing");
    expect(controller.getOpenNotebooks()[0]).toEqual(
      expect.objectContaining({
        uri: "local://file/existing",
        requestedUri: "fs://workspace/demo/file/existing.json",
        name: "renamed.json",
        state: "loaded",
      }),
    );
  });

  it("closes a notebook, disposes its model, and returns a fallback URI", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/a", {
      id: "local://file/a",
      name: "a.json",
      remoteId: "local://file/a",
      notebook: createNotebook("a"),
    });
    localStore.records.set("local://file/b", {
      id: "local://file/b",
      name: "b.json",
      remoteId: "local://file/b",
      notebook: createNotebook("b"),
    });
    const controller = getNotebookDataController();
    controller.configureOwnershipManager(createFakeOwnershipManager());
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });
    await controller.openNotebook("local://file/a");
    await controller.openNotebook("local://file/b");

    const fallback = controller.closeNotebook("local://file/b");

    expect(fallback).toBe("local://file/a");
    expect(controller.getNotebookData("local://file/b")).toBeUndefined();
    expect(controller.getOpenNotebooks().map((item) => item.uri)).toEqual([
      "local://file/a",
    ]);
  });

  it("returns null and leaves selection candidates unchanged when closing a stale URI", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/a", {
      id: "local://file/a",
      name: "a.json",
      remoteId: "local://file/a",
      notebook: createNotebook("a"),
    });
    localStore.records.set("local://file/b", {
      id: "local://file/b",
      name: "b.json",
      remoteId: "local://file/b",
      notebook: createNotebook("b"),
    });
    const controller = getNotebookDataController();
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });
    await controller.openNotebook("local://file/a");
    await controller.openNotebook("local://file/b");

    const fallback = controller.closeNotebook("local://file/missing");

    expect(fallback).toBeNull();
    expect(controller.getOpenNotebooks().map((item) => item.uri)).toEqual([
      "local://file/a",
      "local://file/b",
    ]);
  });

  it("restores legacy open-notebook storage without changing the storage shape", () => {
    window.localStorage.setItem(
      "runme/openNotebooks",
      JSON.stringify([
        {
          uri: "local://file/restored",
          name: "restored.json",
          type: "file",
          children: [],
          parents: [],
        },
      ]),
    );

    const controller = getNotebookDataController();
    controller.configureOwnershipManager(createFakeOwnershipManager());

    expect(controller.getOpenNotebooks()).toEqual([
      expect.objectContaining({
        uri: "local://file/restored",
        requestedUri: "local://file/restored",
        name: "restored.json",
        state: "loading",
      }),
    ]);
    expect(controller.getNotebookData("local://file/restored")).toBeUndefined();
    controller.configureStores({
      localNotebooks: createFakeLocalNotebooks() as unknown as LocalNotebooks,
    });
    expect(JSON.parse(window.sessionStorage.getItem("runme/openNotebooks") ?? "[]")).toEqual([
      expect.objectContaining({
        uri: "local://file/restored",
        name: "restored.json",
      }),
    ]);
  });

  it("keeps blocked entries metadata-only", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/blocked", {
      id: "local://file/blocked",
      name: "blocked.json",
      remoteId: "local://file/blocked",
      notebook: createNotebook("blocked"),
    });
    const owner = {
      notebookUri: "local://file/blocked",
      ownerTabId: "tab-other",
      ownerLabel: "Other tab",
      ownerUrl: "http://localhost/",
      ownerStartedAt: "2026-05-22T12:00:00.000Z",
      epoch: "epoch-other",
    };
    const controller = getNotebookDataController();
    controller.configureOwnershipManager(
      createFakeOwnershipManager({ status: "blocked", owner }),
    );
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });

    const result = await controller.openNotebook("local://file/blocked");

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: "local://file/blocked",
        state: "blocked",
        owner,
      }),
    );
    expect(controller.getNotebookData("local://file/blocked")).toBeUndefined();
  });

  it("returns unsupported state without creating editable NotebookData", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/unsupported", {
      id: "local://file/unsupported",
      name: "unsupported.json",
      remoteId: "local://file/unsupported",
      notebook: createNotebook("unsupported"),
    });
    const controller = getNotebookDataController();
    controller.configureOwnershipManager(
      createFakeOwnershipManager({
        status: "unsupported",
        reason: "web_locks_unavailable",
      }),
    );
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });

    const result = await controller.openNotebook("local://file/unsupported");

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: "local://file/unsupported",
        state: "error",
      }),
    );
    expect(result.entry.errorMessage).toContain("does not support");
    expect(result.entry.errorMessage).toContain("Web Locks");
    expect(controller.getNotebookData("local://file/unsupported")).toBeUndefined();
  });

  it("releases notebook ownership when loading the local notebook fails", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/load-error", {
      id: "local://file/load-error",
      name: "load-error.json",
      remoteId: "local://file/load-error",
      notebook: createNotebook("load error"),
    });
    localStore.load.mockRejectedValueOnce(new Error("load failed"));
    const release = vi.fn();
    const controller = getNotebookDataController();
    controller.configureOwnershipManager(
      createFakeOwnershipManager({
        status: "acquired",
        lease: {
          notebookUri: "local://file/load-error",
          tabId: "tab-test",
          epoch: "epoch-test",
          release,
          isCurrentOwner: vi.fn(async () => true),
        },
      }),
    );
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });

    const result = await controller.openNotebook("local://file/load-error");

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: "local://file/load-error",
        state: "error",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not release an existing loaded notebook when a duplicate open cannot reload", async () => {
    const localStore = createFakeLocalNotebooks();
    localStore.records.set("local://file/demo", {
      id: "local://file/demo",
      name: "demo.json",
      remoteId: "local://file/demo",
      notebook: createNotebook("loaded"),
    });
    const release = vi.fn();
    const controller = getNotebookDataController();
    controller.configureOwnershipManager(
      createFakeOwnershipManager({
        status: "acquired",
        lease: {
          notebookUri: "local://file/demo",
          tabId: "tab-test",
          epoch: "epoch-test",
          release,
          isCurrentOwner: vi.fn(async () => true),
        },
      }),
    );
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    });

    await controller.openNotebook("local://file/demo");
    localStore.load.mockRejectedValueOnce(new Error("load failed"));

    const result = await controller.openNotebook("local://file/demo");

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: "local://file/demo",
        state: "loaded",
      }),
    );
    expect(
      controller.getNotebookData("local://file/demo")?.getSnapshot().loaded,
    ).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });
});
