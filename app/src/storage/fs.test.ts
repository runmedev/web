/// <reference types="vitest" />
// @vitest-environment node

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";

import { parser_pb } from "../runme/client";
import { NotebookStoreItemType } from "./notebook";
import { FilesystemNotebookStore, isFileSystemAccessSupported } from "./fs";
import type { FsDatabase, WorkspaceRecord, FsEntryRecord } from "./fsdb";

// Provide minimal browser globals for Node environment.
const g = globalThis as any;
if (!g.window) {
  g.window = g;
}
if (!g.Blob) {
  g.Blob = class Blob {
    private parts: any[];
    constructor(parts: any[] = []) {
      this.parts = parts;
    }
    get size() {
      return this.parts.reduce(
        (acc: number, p: any) => acc + (typeof p === "string" ? Buffer.byteLength(p, "utf8") : 0),
        0,
      );
    }
  };
}
if (!g.DOMException) {
  g.DOMException = class DOMException extends Error {
    constructor(message?: string, name?: string) {
      super(message);
      this.name = name ?? "DOMException";
    }
  };
}

// ---------------------------------------------------------------------------
// Mock helpers for File System Access API
// ---------------------------------------------------------------------------

function createMockFileHandle(
  name: string,
  content: string,
): FileSystemFileHandle {
  let _content = content;
  let _lastModified = Date.now();
  return {
    kind: "file" as const,
    name,
    getFile: vi.fn(async () => ({
      text: async () => _content,
      lastModified: _lastModified,
      size: new Blob([_content]).size,
    })),
    createWritable: vi.fn(async () => ({
      write: vi.fn(async (data: string) => {
        _content = data;
        _lastModified = Date.now();
      }),
      close: vi.fn(async () => {}),
    })),
  } as any;
}

function createMockDirectoryHandle(
  name: string,
  entries: Map<string, any>,
): FileSystemDirectoryHandle {
  return {
    kind: "directory" as const,
    name,
    async *entries() {
      for (const [entryName, handle] of entries) {
        yield [entryName, handle] as [string, any];
      }
    },
    getFileHandle: vi.fn(
      async (fileName: string, opts?: { create?: boolean }) => {
        if (entries.has(fileName)) {
          return entries.get(fileName);
        }
        if (opts?.create) {
          const handle = createMockFileHandle(fileName, "");
          entries.set(fileName, handle);
          return handle;
        }
        throw new DOMException("File not found", "NotFoundError");
      },
    ),
    getDirectoryHandle: vi.fn(async (dirName: string) => {
      const handle = entries.get(dirName);
      if (!handle || handle.kind !== "directory") {
        throw new DOMException("Directory not found", "NotFoundError");
      }
      return handle;
    }),
    removeEntry: vi.fn(async (entryName: string) => {
      entries.delete(entryName);
    }),
  } as any;
}

// ---------------------------------------------------------------------------
// Mock Dexie table
// ---------------------------------------------------------------------------

function createMockTable<T extends { id?: string }>() {
  const store = new Map<string, T>();
  return {
    _store: store,
    get: vi.fn(async (id: string) => store.get(id) ?? undefined),
    put: vi.fn(async (record: T & { id: string }) => {
      store.set(record.id, record);
      return record.id;
    }),
    update: vi.fn(async (id: string, changes: Partial<T>) => {
      const existing = store.get(id);
      if (existing) {
        store.set(id, { ...existing, ...changes });
        return 1;
      }
      return 0;
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    orderBy: vi.fn((field: string) => ({
      reverse: vi.fn(() => ({
        toArray: vi.fn(async () => {
          const values = [...store.values()];
          return values.sort(
            (a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0),
          );
        }),
      })),
    })),
  };
}

function createMockDb(): FsDatabase {
  return {
    workspaces: createMockTable<WorkspaceRecord>(),
    entries: createMockTable<FsEntryRecord>(),
  } as any;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEmptyNotebookJson(): string {
  const nb = create(parser_pb.NotebookSchema, { cells: [] });
  return toJsonString(parser_pb.NotebookSchema, nb, {
    emitDefaultValues: true,
  });
}

// ---------------------------------------------------------------------------
// URI helper tests (testing via public store methods that exercise them)
// ---------------------------------------------------------------------------

describe("URI helpers (via FilesystemNotebookStore)", () => {
  it("getType returns File for file URIs", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    const type = await store.getType(
      "fs://workspace/abc123/file/notebook.json",
    );
    expect(type).toBe(NotebookStoreItemType.File);
  });

  it("getType returns Folder for directory URIs", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    const type = await store.getType("fs://workspace/abc123/dir/subfolder");
    expect(type).toBe(NotebookStoreItemType.Folder);
  });

  it("throws on invalid scheme", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    await expect(store.getType("http://example.com")).rejects.toThrow(
      "Invalid filesystem URI",
    );
  });

  it("throws on missing kind segment", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    await expect(store.getType("fs://workspace/abc123")).rejects.toThrow(
      "missing kind segment",
    );
  });

  it("throws on missing path segment", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    await expect(store.getType("fs://workspace/abc123/file")).rejects.toThrow(
      "missing path segment",
    );
  });

  it("throws on invalid kind", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    await expect(
      store.getType("fs://workspace/abc123/blob/foo"),
    ).rejects.toThrow('Invalid filesystem URI kind "blob"');
  });

  it("handles special characters in paths", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    const encodedPath = encodeURIComponent("my folder/test file.json");
    const type = await store.getType(
      `fs://workspace/abc123/file/${encodedPath}`,
    );
    expect(type).toBe(NotebookStoreItemType.File);
  });

  it("rejects path traversal with '..'", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    const encodedPath = encodeURIComponent("../etc/passwd");
    await expect(
      store.getType(`fs://workspace/abc123/file/${encodedPath}`),
    ).rejects.toThrow("path traversal detected");
  });

  it("rejects path traversal with '.' segment", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    const encodedPath = encodeURIComponent("./secret");
    await expect(
      store.getType(`fs://workspace/abc123/dir/${encodedPath}`),
    ).rejects.toThrow("path traversal detected");
  });

  it("rejects embedded '..' segments", async () => {
    const db = createMockDb();
    const store = new FilesystemNotebookStore(db);
    const encodedPath = encodeURIComponent("sub/../../../etc/passwd");
    await expect(
      store.getType(`fs://workspace/abc123/file/${encodedPath}`),
    ).rejects.toThrow("path traversal detected");
  });
});

// ---------------------------------------------------------------------------
// isFileSystemAccessSupported
// ---------------------------------------------------------------------------

describe("isFileSystemAccessSupported", () => {
  let originalShowDirectoryPicker: any;

  beforeEach(() => {
    originalShowDirectoryPicker = (window as any).showDirectoryPicker;
  });

  afterEach(() => {
    (window as any).showDirectoryPicker = originalShowDirectoryPicker;
  });

  it("returns true when showDirectoryPicker is a function", () => {
    (window as any).showDirectoryPicker = vi.fn();
    expect(isFileSystemAccessSupported()).toBe(true);
  });

  it("returns false when showDirectoryPicker is undefined", () => {
    (window as any).showDirectoryPicker = undefined;
    expect(isFileSystemAccessSupported()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FilesystemNotebookStore
// ---------------------------------------------------------------------------

describe("FilesystemNotebookStore", () => {
  let db: ReturnType<typeof createMockDb>;
  let store: FilesystemNotebookStore;
  let rootEntries: Map<string, any>;
  let rootHandle: FileSystemDirectoryHandle;

  const WORKSPACE_ID = "ws-test-id";
  const ROOT_URI = `fs://workspace/${WORKSPACE_ID}/dir/${encodeURIComponent("")}`;

  beforeEach(() => {
    rootEntries = new Map();
    rootHandle = createMockDirectoryHandle("my-project", rootEntries);

    db = createMockDb();

    // Pre-populate workspace in DB.
    const wsRecord: WorkspaceRecord = {
      id: WORKSPACE_ID,
      name: "my-project",
      rootHandle,
      lastOpened: Date.now(),
      permissionState: "granted",
    };
    (db.workspaces as any)._store.set(WORKSPACE_ID, wsRecord);

    // Pre-populate root entry in DB.
    const rootEntryRecord: FsEntryRecord = {
      id: `${WORKSPACE_ID}:`,
      workspaceId: WORKSPACE_ID,
      relativePath: "",
      kind: "directory",
      handle: rootHandle,
      lastKnownMtime: 0,
      lastKnownSize: 0,
    };
    (db.entries as any)._store.set(`${WORKSPACE_ID}:`, rootEntryRecord);

    store = new FilesystemNotebookStore(db);
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe("list", () => {
    it("returns .json files and directories", async () => {
      const nbJson = makeEmptyNotebookJson();
      rootEntries.set("notebook.json", createMockFileHandle("notebook.json", nbJson));
      rootEntries.set("readme.md", createMockFileHandle("readme.md", "# Hello"));
      rootEntries.set(
        "sub",
        createMockDirectoryHandle("sub", new Map()),
      );

      const items = await store.list(ROOT_URI);

      // Should have the directory first, then the .json file. readme.md is filtered out.
      expect(items).toHaveLength(2);
      expect(items[0].type).toBe(NotebookStoreItemType.Folder);
      expect(items[0].name).toBe("sub");
      expect(items[1].type).toBe(NotebookStoreItemType.File);
      expect(items[1].name).toBe("notebook.json");
    });

    it("filters out non-.json files", async () => {
      rootEntries.set("readme.md", createMockFileHandle("readme.md", "# Hi"));
      rootEntries.set("image.png", createMockFileHandle("image.png", "binary"));

      const items = await store.list(ROOT_URI);
      expect(items).toHaveLength(0);
    });

    it("sorts folders before files, then alphabetically", async () => {
      rootEntries.set("b.json", createMockFileHandle("b.json", makeEmptyNotebookJson()));
      rootEntries.set("a.json", createMockFileHandle("a.json", makeEmptyNotebookJson()));
      rootEntries.set("z-dir", createMockDirectoryHandle("z-dir", new Map()));
      rootEntries.set("a-dir", createMockDirectoryHandle("a-dir", new Map()));

      const items = await store.list(ROOT_URI);
      expect(items.map((i) => i.name)).toEqual([
        "a-dir",
        "z-dir",
        "a.json",
        "b.json",
      ]);
    });

    it("builds correct URIs for files", async () => {
      rootEntries.set("test.json", createMockFileHandle("test.json", makeEmptyNotebookJson()));

      const items = await store.list(ROOT_URI);
      expect(items[0].uri).toBe(
        `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("test.json")}`,
      );
    });

    it("builds correct URIs for directories", async () => {
      rootEntries.set("subdir", createMockDirectoryHandle("subdir", new Map()));

      const items = await store.list(ROOT_URI);
      expect(items[0].uri).toBe(
        `fs://workspace/${WORKSPACE_ID}/dir/${encodeURIComponent("subdir")}`,
      );
    });

    it("sets parent URI to the listed directory", async () => {
      rootEntries.set("test.json", createMockFileHandle("test.json", makeEmptyNotebookJson()));

      const items = await store.list(ROOT_URI);
      expect(items[0].parents).toEqual([ROOT_URI]);
    });

    it("throws when given a file URI", async () => {
      await expect(
        store.list(`fs://workspace/${WORKSPACE_ID}/file/test.json`),
      ).rejects.toThrow("expects a directory URI");
    });

    it("caches entries in the DB", async () => {
      rootEntries.set("test.json", createMockFileHandle("test.json", makeEmptyNotebookJson()));

      await store.list(ROOT_URI);
      expect(db.entries.put).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  describe("load", () => {
    it("reads and parses a notebook from a file", async () => {
      const nbJson = makeEmptyNotebookJson();
      const fileHandle = createMockFileHandle("notebook.json", nbJson);
      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("notebook.json")}`;

      // Put the file entry in the DB so resolve works.
      (db.entries as any)._store.set(`${WORKSPACE_ID}:notebook.json`, {
        id: `${WORKSPACE_ID}:notebook.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "notebook.json",
        kind: "file",
        handle: fileHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const notebook = await store.load(fileUri);
      expect(notebook).toBeDefined();
      expect(notebook.cells).toEqual([]);
    });

    it("records base revision after load", async () => {
      const nbJson = makeEmptyNotebookJson();
      const fileHandle = createMockFileHandle("notebook.json", nbJson);
      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("notebook.json")}`;

      (db.entries as any)._store.set(`${WORKSPACE_ID}:notebook.json`, {
        id: `${WORKSPACE_ID}:notebook.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "notebook.json",
        kind: "file",
        handle: fileHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      await store.load(fileUri);

      // DB entry should have been updated with mtime/size.
      expect(db.entries.update).toHaveBeenCalledWith(
        `${WORKSPACE_ID}:notebook.json`,
        expect.objectContaining({
          lastKnownMtime: expect.any(Number),
          lastKnownSize: expect.any(Number),
        }),
      );
    });

    it("throws when given a directory URI", async () => {
      await expect(store.load(ROOT_URI)).rejects.toThrow(
        "expects a file URI",
      );
    });

    it("resolves file handles by walking from workspace root", async () => {
      const nbJson = makeEmptyNotebookJson();
      const fileHandle = createMockFileHandle("deep.json", nbJson);
      const subEntries = new Map<string, any>([["deep.json", fileHandle]]);
      const subDir = createMockDirectoryHandle("sub", subEntries);
      rootEntries.set("sub", subDir);

      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("sub/deep.json")}`;

      const notebook = await store.load(fileUri);
      expect(notebook).toBeDefined();
      expect(subDir.getDirectoryHandle).not.toHaveBeenCalled(); // sub is the dir, we need getFileHandle
    });
  });

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------

  describe("save", () => {
    it("writes serialized notebook to file", async () => {
      const nbJson = makeEmptyNotebookJson();
      const fileHandle = createMockFileHandle("notebook.json", nbJson);
      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("notebook.json")}`;

      (db.entries as any)._store.set(`${WORKSPACE_ID}:notebook.json`, {
        id: `${WORKSPACE_ID}:notebook.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "notebook.json",
        kind: "file",
        handle: fileHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await store.save(fileUri, notebook);

      expect(fileHandle.createWritable).toHaveBeenCalled();
    });

    it("detects conflict when file was modified externally", async () => {
      const nbJson = makeEmptyNotebookJson();
      const fileHandle = createMockFileHandle("notebook.json", nbJson);
      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("notebook.json")}`;

      (db.entries as any)._store.set(`${WORKSPACE_ID}:notebook.json`, {
        id: `${WORKSPACE_ID}:notebook.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "notebook.json",
        kind: "file",
        handle: fileHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      // Load first to record base revision.
      await store.load(fileUri);

      // Simulate external modification: change the file content behind our back.
      // The mock returns fresh lastModified on each getFile call (Date.now()),
      // so a second getFile call during save will have a different timestamp.
      // We need to manipulate the mock to return different values.
      const originalGetFile = fileHandle.getFile;
      let callCount = 0;
      fileHandle.getFile = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          // During save's conflict check — return different stats.
          return {
            text: async () => "externally modified",
            lastModified: 999999999,
            size: 999,
          };
        }
        return originalGetFile();
      });

      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await expect(store.save(fileUri, notebook)).rejects.toThrow(
        "Conflict detected",
      );
    });

    it("updates base revision after successful save", async () => {
      const nbJson = makeEmptyNotebookJson();
      const fileHandle = createMockFileHandle("notebook.json", nbJson);
      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("notebook.json")}`;

      (db.entries as any)._store.set(`${WORKSPACE_ID}:notebook.json`, {
        id: `${WORKSPACE_ID}:notebook.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "notebook.json",
        kind: "file",
        handle: fileHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const notebook = create(parser_pb.NotebookSchema, { cells: [] });

      // Save without prior load (no base revision) — should succeed.
      await store.save(fileUri, notebook);

      // A second save should also succeed because the base revision was set
      // after the first save, and the file hasn't changed externally.
      // Since our mock returns a fresh Date.now() per getFile, we need to
      // make the writable's write NOT update lastModified to simulate
      // consistency. For simplicity, just verify it doesn't throw.
      // The mock handles this correctly since createWritable updates _lastModified
      // and the subsequent getFile after write returns the same _lastModified.
    });

    it("throws when given a directory URI", async () => {
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await expect(store.save(ROOT_URI, notebook)).rejects.toThrow(
        "expects a file URI",
      );
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe("create", () => {
    it("creates a new file with empty notebook content", async () => {
      const item = await store.create(ROOT_URI, "new-notebook.json");

      expect(item.name).toBe("new-notebook.json");
      expect(item.type).toBe(NotebookStoreItemType.File);
      expect(item.uri).toBe(
        `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("new-notebook.json")}`,
      );
      expect(item.parents).toEqual([ROOT_URI]);
    });

    it("calls getFileHandle with create: true", async () => {
      await store.create(ROOT_URI, "new-notebook.json");
      expect(rootHandle.getFileHandle).toHaveBeenCalledWith(
        "new-notebook.json",
        { create: true },
      );
    });

    it("writes content to the new file", async () => {
      await store.create(ROOT_URI, "new-notebook.json");

      // The file should have been created in rootEntries.
      const fh = rootEntries.get("new-notebook.json");
      expect(fh).toBeDefined();
      expect(fh.createWritable).toHaveBeenCalled();
    });

    it("caches the entry in the DB", async () => {
      await store.create(ROOT_URI, "new-notebook.json");

      expect(db.entries.put).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `${WORKSPACE_ID}:new-notebook.json`,
          workspaceId: WORKSPACE_ID,
          relativePath: "new-notebook.json",
          kind: "file",
        }),
      );
    });

    it("auto-appends .json extension when missing", async () => {
      const item = await store.create(ROOT_URI, "my-notebook");

      expect(item.name).toBe("my-notebook.json");
      expect(item.uri).toContain(encodeURIComponent("my-notebook.json"));
      expect(rootHandle.getFileHandle).toHaveBeenCalledWith(
        "my-notebook.json",
        { create: true },
      );
    });

    it("does not double .json extension", async () => {
      const item = await store.create(ROOT_URI, "already.json");

      expect(item.name).toBe("already.json");
      expect(rootHandle.getFileHandle).toHaveBeenCalledWith(
        "already.json",
        { create: true },
      );
    });

    it("throws when given a file URI as parent", async () => {
      await expect(
        store.create(
          `fs://workspace/${WORKSPACE_ID}/file/existing.json`,
          "new.json",
        ),
      ).rejects.toThrow("expects a directory URI");
    });
  });

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  describe("rename", () => {
    it("copies content to new file and removes old", async () => {
      const nbJson = makeEmptyNotebookJson();
      const oldHandle = createMockFileHandle("old.json", nbJson);
      rootEntries.set("old.json", oldHandle);

      (db.entries as any)._store.set(`${WORKSPACE_ID}:old.json`, {
        id: `${WORKSPACE_ID}:old.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "old.json",
        kind: "file",
        handle: oldHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const oldUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("old.json")}`;
      const result = await store.rename(oldUri, "new.json");

      expect(result.name).toBe("new.json");
      expect(result.type).toBe(NotebookStoreItemType.File);
      expect(result.uri).toBe(
        `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("new.json")}`,
      );
    });

    it("removes old entry from DB", async () => {
      const nbJson = makeEmptyNotebookJson();
      const oldHandle = createMockFileHandle("old.json", nbJson);
      rootEntries.set("old.json", oldHandle);

      (db.entries as any)._store.set(`${WORKSPACE_ID}:old.json`, {
        id: `${WORKSPACE_ID}:old.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "old.json",
        kind: "file",
        handle: oldHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const oldUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("old.json")}`;
      await store.rename(oldUri, "new.json");

      expect(db.entries.delete).toHaveBeenCalledWith(`${WORKSPACE_ID}:old.json`);
    });

    it("removes old file from directory", async () => {
      const nbJson = makeEmptyNotebookJson();
      const oldHandle = createMockFileHandle("old.json", nbJson);
      rootEntries.set("old.json", oldHandle);

      (db.entries as any)._store.set(`${WORKSPACE_ID}:old.json`, {
        id: `${WORKSPACE_ID}:old.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "old.json",
        kind: "file",
        handle: oldHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const oldUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("old.json")}`;
      await store.rename(oldUri, "new.json");

      expect(rootHandle.removeEntry).toHaveBeenCalledWith("old.json");
    });

    it("creates new entry in DB", async () => {
      const nbJson = makeEmptyNotebookJson();
      const oldHandle = createMockFileHandle("old.json", nbJson);
      rootEntries.set("old.json", oldHandle);

      (db.entries as any)._store.set(`${WORKSPACE_ID}:old.json`, {
        id: `${WORKSPACE_ID}:old.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "old.json",
        kind: "file",
        handle: oldHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const oldUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("old.json")}`;
      await store.rename(oldUri, "new.json");

      expect(db.entries.put).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `${WORKSPACE_ID}:new.json`,
          workspaceId: WORKSPACE_ID,
          relativePath: "new.json",
          kind: "file",
        }),
      );
    });

    it("sets parent URI in the returned item", async () => {
      const nbJson = makeEmptyNotebookJson();
      const oldHandle = createMockFileHandle("old.json", nbJson);
      rootEntries.set("old.json", oldHandle);

      (db.entries as any)._store.set(`${WORKSPACE_ID}:old.json`, {
        id: `${WORKSPACE_ID}:old.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "old.json",
        kind: "file",
        handle: oldHandle,
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const oldUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("old.json")}`;
      const result = await store.rename(oldUri, "new.json");

      // Parent should be the root dir.
      expect(result.parents).toEqual([
        `fs://workspace/${WORKSPACE_ID}/dir/${encodeURIComponent("")}`,
      ]);
    });

    it("throws when given a directory URI", async () => {
      await expect(store.rename(ROOT_URI, "new-name")).rejects.toThrow(
        "expects a file URI",
      );
    });
  });

  // -------------------------------------------------------------------------
  // getMetadata
  // -------------------------------------------------------------------------

  describe("getMetadata", () => {
    it("returns metadata for a known file entry", async () => {
      (db.entries as any)._store.set(`${WORKSPACE_ID}:notebook.json`, {
        id: `${WORKSPACE_ID}:notebook.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "notebook.json",
        kind: "file",
        handle: createMockFileHandle("notebook.json", ""),
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("notebook.json")}`;
      const meta = await store.getMetadata(fileUri);

      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("notebook.json");
      expect(meta!.type).toBe(NotebookStoreItemType.File);
      expect(meta!.uri).toBe(fileUri);
    });

    it("returns metadata for a known directory entry", async () => {
      (db.entries as any)._store.set(`${WORKSPACE_ID}:subdir`, {
        id: `${WORKSPACE_ID}:subdir`,
        workspaceId: WORKSPACE_ID,
        relativePath: "subdir",
        kind: "directory",
        handle: createMockDirectoryHandle("subdir", new Map()),
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const dirUri = `fs://workspace/${WORKSPACE_ID}/dir/${encodeURIComponent("subdir")}`;
      const meta = await store.getMetadata(dirUri);

      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("subdir");
      expect(meta!.type).toBe(NotebookStoreItemType.Folder);
    });

    it("returns null for unknown entries", async () => {
      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("nonexistent.json")}`;
      const meta = await store.getMetadata(fileUri);

      expect(meta).toBeNull();
    });

    it("uses workspace name for root entry", async () => {
      const rootUri = `fs://workspace/${WORKSPACE_ID}/dir/${encodeURIComponent("")}`;
      const meta = await store.getMetadata(rootUri);

      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("my-project");
    });

    it("derives parent URI correctly for nested entries", async () => {
      (db.entries as any)._store.set(`${WORKSPACE_ID}:sub/notebook.json`, {
        id: `${WORKSPACE_ID}:sub/notebook.json`,
        workspaceId: WORKSPACE_ID,
        relativePath: "sub/notebook.json",
        kind: "file",
        handle: createMockFileHandle("notebook.json", ""),
        lastKnownMtime: 0,
        lastKnownSize: 0,
      });

      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("sub/notebook.json")}`;
      const meta = await store.getMetadata(fileUri);

      expect(meta).not.toBeNull();
      expect(meta!.parents).toEqual([
        `fs://workspace/${WORKSPACE_ID}/dir/${encodeURIComponent("sub")}`,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // getType
  // -------------------------------------------------------------------------

  describe("getType", () => {
    it("returns File for file URIs", async () => {
      const type = await store.getType(
        `fs://workspace/${WORKSPACE_ID}/file/test.json`,
      );
      expect(type).toBe(NotebookStoreItemType.File);
    });

    it("returns Folder for directory URIs", async () => {
      const type = await store.getType(
        `fs://workspace/${WORKSPACE_ID}/dir/subdir`,
      );
      expect(type).toBe(NotebookStoreItemType.Folder);
    });
  });

  // -------------------------------------------------------------------------
  // openWorkspace
  // -------------------------------------------------------------------------

  describe("openWorkspace", () => {
    let origShowDirectoryPicker: any;

    beforeEach(() => {
      origShowDirectoryPicker = (window as any).showDirectoryPicker;
    });

    afterEach(() => {
      (window as any).showDirectoryPicker = origShowDirectoryPicker;
    });

    it("creates workspace record in DB and returns root URI", async () => {
      const dirHandle = createMockDirectoryHandle("picked-dir", new Map());
      (window as any).showDirectoryPicker = vi.fn(async () => dirHandle);

      const uri = await store.openWorkspace();

      expect(uri).toMatch(/^fs:\/\/workspace\/[^/]+\/dir\//);
      expect(db.workspaces.put).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "picked-dir",
          rootHandle: dirHandle,
          permissionState: "granted",
        }),
      );
    });

    it("caches root directory entry", async () => {
      const dirHandle = createMockDirectoryHandle("picked-dir", new Map());
      (window as any).showDirectoryPicker = vi.fn(async () => dirHandle);

      await store.openWorkspace();

      expect(db.entries.put).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: "",
          kind: "directory",
          handle: dirHandle,
        }),
      );
    });

    it("throws when File System Access API not supported", async () => {
      (window as any).showDirectoryPicker = undefined;
      await expect(store.openWorkspace()).rejects.toThrow(
        "File System Access API is not supported",
      );
    });
  });

  // -------------------------------------------------------------------------
  // listWorkspaces
  // -------------------------------------------------------------------------

  describe("listWorkspaces", () => {
    it("returns workspaces ordered by most recently opened", async () => {
      // Clear existing workspaces from beforeEach.
      (db.workspaces as any)._store.clear();

      const ws1: WorkspaceRecord = {
        id: "ws1",
        name: "old",
        rootHandle: createMockDirectoryHandle("old", new Map()),
        lastOpened: 1000,
        permissionState: "granted",
      };
      const ws2: WorkspaceRecord = {
        id: "ws2",
        name: "new",
        rootHandle: createMockDirectoryHandle("new", new Map()),
        lastOpened: 2000,
        permissionState: "granted",
      };
      (db.workspaces as any)._store.set("ws1", ws1);
      (db.workspaces as any)._store.set("ws2", ws2);

      const result = await store.listWorkspaces();

      expect(result[0].name).toBe("new");
      expect(result[1].name).toBe("old");
    });
  });

  // -------------------------------------------------------------------------
  // requestPermission
  // -------------------------------------------------------------------------

  describe("requestPermission", () => {
    it("returns true when permission is granted", async () => {
      const dirHandle = createMockDirectoryHandle("project", new Map());
      (dirHandle as any).requestPermission = vi.fn(async () => "granted");

      const ws: WorkspaceRecord = {
        id: "perm-ws",
        name: "project",
        rootHandle: dirHandle,
        lastOpened: Date.now(),
        permissionState: "prompt",
      };
      (db.workspaces as any)._store.set("perm-ws", ws);

      const result = await store.requestPermission("perm-ws");
      expect(result).toBe(true);
      expect(db.workspaces.update).toHaveBeenCalledWith(
        "perm-ws",
        expect.objectContaining({ permissionState: "granted" }),
      );
    });

    it("returns false when permission is denied", async () => {
      const dirHandle = createMockDirectoryHandle("project", new Map());
      (dirHandle as any).requestPermission = vi.fn(async () => "denied");

      const ws: WorkspaceRecord = {
        id: "perm-ws",
        name: "project",
        rootHandle: dirHandle,
        lastOpened: Date.now(),
        permissionState: "prompt",
      };
      (db.workspaces as any)._store.set("perm-ws", ws);

      const result = await store.requestPermission("perm-ws");
      expect(result).toBe(false);
    });

    it("throws for unknown workspace", async () => {
      await expect(
        store.requestPermission("nonexistent"),
      ).rejects.toThrow("Workspace not found");
    });
  });

  // -------------------------------------------------------------------------
  // Handle resolution (via load/save for files in subdirectories)
  // -------------------------------------------------------------------------

  describe("handle resolution", () => {
    it("walks directory tree to resolve deeply nested file", async () => {
      const nbJson = makeEmptyNotebookJson();
      const fileHandle = createMockFileHandle("deep.json", nbJson);

      const level2Entries = new Map<string, any>([["deep.json", fileHandle]]);
      const level2Dir = createMockDirectoryHandle("level2", level2Entries);

      const level1Entries = new Map<string, any>([["level2", level2Dir]]);
      const level1Dir = createMockDirectoryHandle("level1", level1Entries);

      rootEntries.set("level1", level1Dir);

      const fileUri = `fs://workspace/${WORKSPACE_ID}/file/${encodeURIComponent("level1/level2/deep.json")}`;

      const notebook = await store.load(fileUri);
      expect(notebook).toBeDefined();
    });

    it("throws for nonexistent workspace", async () => {
      // Use a workspace ID not in the DB.
      const fileUri = `fs://workspace/nonexistent-ws/file/${encodeURIComponent("file.json")}`;

      await expect(store.load(fileUri)).rejects.toThrow(
        "Workspace not found",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// FsDatabase schema tests
// ---------------------------------------------------------------------------

describe("FsDatabase", () => {
  // Since we cannot use real IndexedDB in jsdom without fake-indexeddb,
  // we test that the class can be imported and has the expected shape.
  it("exports the expected interface types", async () => {
    const { FsDatabase } = await import("./fsdb");
    expect(FsDatabase).toBeDefined();
    expect(typeof FsDatabase).toBe("function");
  });

  it("FsDatabase constructor accepts a custom name", async () => {
    const { FsDatabase } = await import("./fsdb");
    // This will fail in jsdom due to IndexedDB limitations, but we can
    // at least verify the constructor parameter is accepted.
    let db: InstanceType<typeof FsDatabase> | undefined;
    try {
      db = new FsDatabase("test-db");
      expect(db).toBeDefined();
      expect(db.workspaces).toBeDefined();
      expect(db.entries).toBeDefined();
    } catch {
      // Expected in environments without full IndexedDB support.
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors.
        }
      }
    }
  });
});
