/// <reference types="vitest" />
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import LocalNotebooks, {
  type LocalFileRecord,
  type LocalFolderRecord,
} from "./local";
import { NotebookStoreItemType } from "./notebook";

function createMockTable<T extends { id: string }>() {
  const store = new Map<string, T>();
  return {
    _store: store,
    get: vi.fn(async (id: string) => store.get(id) ?? undefined),
    put: vi.fn(async (record: T) => {
      store.set(record.id, record);
      return record.id;
    }),
    update: vi.fn(async (id: string, changes: Partial<T>) => {
      const existing = store.get(id);
      if (!existing) {
        return 0;
      }
      store.set(id, { ...existing, ...changes });
      return 1;
    }),
    where: vi.fn((field: keyof T) => ({
      equals: vi.fn((value: unknown) => ({
        first: vi.fn(async () =>
          [...store.values()].find((record) => record[field] === value),
        ),
      })),
    })),
    filter: vi.fn((predicate: (record: T) => boolean) => ({
      toArray: vi.fn(async () => [...store.values()].filter(predicate)),
      first: vi.fn(async () => [...store.values()].find(predicate)),
    })),
  };
}

function createTestStore(driveStore: unknown) {
  const localStore = Object.create(LocalNotebooks.prototype) as any;
  localStore.files = createMockTable<LocalFileRecord>();
  localStore.folders = createMockTable<LocalFolderRecord>();
  localStore.driveStore = driveStore;
  localStore.filesystemStore = null;
  localStore.inFlightSyncs = new Map();
  localStore.syncListeners = new Map();
  localStore.syncSubjects = new Map();
  localStore.markdownSyncSubjects = new Map();
  return localStore as LocalNotebooks;
}

describe("LocalNotebooks pending Drive create", () => {
  it("persists pending upstream parent when Drive create fails", async () => {
    const parentRemoteUri = "https://drive.google.com/drive/folders/folder123";
    const driveStore = {
      create: vi.fn(async () => {
        throw new Error("Google Drive authorization is required.");
      }),
    };
    const store = createTestStore(driveStore);
    await store.folders.put({
      id: "local://folder/drive",
      name: "Drive",
      remoteId: parentRemoteUri,
      children: [],
      lastSynced: "",
    });

    const item = await store.create("local://folder/drive", "draft.json");

    expect(item.type).toBe(NotebookStoreItemType.File);
    const record = await store.files.get(item.uri);
    expect(record?.remoteId).toBe("");
    expect(record?.parentRemoteIdWhenCreated).toBe(parentRemoteUri);
    expect(
      (await store.folders.get("local://folder/drive"))?.children,
    ).toContain(item.uri);
  });

  it("reports pending upstream creation in sync state", async () => {
    const parentRemoteUri = "https://drive.google.com/drive/folders/folder123";
    const store = createTestStore({});
    await store.files.put({
      id: "local://file/pending",
      name: "draft.json",
      remoteId: "",
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: "",
      lastSynced: "",
      doc: "",
      md5Checksum: "",
    });

    await expect(
      store.getSyncState("local://file/pending"),
    ).resolves.toMatchObject({
      status: "pending-upstream-create",
      parentRemoteIdWhenCreated: parentRemoteUri,
    });
  });

  it("creates the Drive file on sync and clears pending parent", async () => {
    const parentRemoteUri = "https://drive.google.com/drive/folders/folder123";
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const driveStore = {
      create: vi.fn(async () => ({
        uri: remoteUri,
        name: "draft.json",
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: "checksum-1",
        headRevisionId: "revision-1",
      })),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: "draft.json",
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      save: vi.fn(async () => ({ conflicted: false })),
    };
    const store = createTestStore(driveStore);
    await store.files.put({
      id: "local://file/pending",
      name: "draft.json",
      remoteId: "",
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: "",
      lastSynced: "",
      doc: "",
      md5Checksum: "",
    });

    await store.sync("local://file/pending");

    const record = await store.files.get("local://file/pending");
    expect(record?.remoteId).toBe(remoteUri);
    expect(record?.parentRemoteIdWhenCreated).toBeUndefined();
    expect(record?.lastRemoteChecksum).toBe("checksum-1");
    expect(record?.lastUpstreamVersion).toEqual({
      checksum: "checksum-1",
      revisionId: "revision-1",
    });
    expect(driveStore.create).toHaveBeenCalledWith(
      parentRemoteUri,
      "draft.json",
    );
  });

  it("does not duplicate a pending Drive file if initial metadata recording fails", async () => {
    const parentRemoteUri = "https://drive.google.com/drive/folders/folder123";
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const driveStore = {
      create: vi.fn(async () => ({
        uri: remoteUri,
        name: "draft.json",
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      getVersionMetadata: vi
        .fn()
        .mockRejectedValueOnce(new Error("metadata unavailable"))
        .mockResolvedValueOnce({
          md5Checksum: "remote-created",
          headRevisionId: "revision-2",
        })
        .mockResolvedValueOnce({
          md5Checksum: "local-saved",
          headRevisionId: "revision-3",
        }),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: "draft.json",
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      save: vi.fn(async () => ({ conflicted: false })),
      saveContent: vi.fn(async () => undefined),
    };
    const store = createTestStore(driveStore);
    await store.files.put({
      id: "local://file/pending",
      name: "draft.json",
      remoteId: "",
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: "",
      lastSynced: "",
      doc: "{malformed-json",
      md5Checksum: "local-checksum",
    });

    await store.sync("local://file/pending");

    const record = await store.files.get("local://file/pending");
    expect(record?.remoteId).toBe(remoteUri);
    expect(record?.parentRemoteIdWhenCreated).toBeUndefined();
    expect(record?.lastRemoteChecksum).toBe("local-saved");
    expect(driveStore.create).toHaveBeenCalledTimes(1);
    expect(driveStore.saveContent).toHaveBeenCalledWith(
      remoteUri,
      "{malformed-json",
      "application/json",
    );
  });

  it("serializes overlapping sync calls for the same pending Drive file", async () => {
    const parentRemoteUri = "https://drive.google.com/drive/folders/folder123";
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const releaseCreatePromise = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const driveStore = {
      create: vi.fn(async () => {
        createStarted();
        await releaseCreatePromise;
        return {
          uri: remoteUri,
          name: "draft.json",
          type: NotebookStoreItemType.File,
          children: [],
          parents: [parentRemoteUri],
        };
      }),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: "checksum-1",
        headRevisionId: "revision-1",
      })),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: "draft.json",
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      save: vi.fn(async () => ({ conflicted: false })),
    };
    const store = createTestStore(driveStore);
    await store.files.put({
      id: "local://file/pending",
      name: "draft.json",
      remoteId: "",
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: "",
      lastSynced: "",
      doc: "",
      md5Checksum: "",
    });

    const firstSync = store.sync("local://file/pending");
    await createStartedPromise;
    const secondSync = store.sync("local://file/pending");
    releaseCreate();
    await Promise.all([firstSync, secondSync]);

    const record = await store.files.get("local://file/pending");
    expect(record?.remoteId).toBe(remoteUri);
    expect(record?.parentRemoteIdWhenCreated).toBeUndefined();
    expect(driveStore.create).toHaveBeenCalledTimes(1);
  });
});
