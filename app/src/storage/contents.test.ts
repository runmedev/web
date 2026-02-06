/// <reference types="vitest" />
// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import { create, toJsonString } from "@bufbuild/protobuf";

import { parser_pb } from "../runme/client";
import { NotebookStoreItemType } from "./notebook";
import {
  ContentsNotebookStore,
  buildContentsUri,
  buildRootUri,
  parseContentsUri,
} from "./contents";

// Provide minimal browser globals for Node environment.
const g = globalThis as any;
if (!g.window) {
  g.window = g;
}

// Provide atob/btoa if missing (Node 18+ has them but just in case).
if (!g.atob) {
  g.atob = (s: string) => Buffer.from(s, "base64").toString("binary");
}
if (!g.btoa) {
  g.btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
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

function b64encode(s: string): string {
  return btoa(s);
}

/** Set up a fetch mock that routes by method name. */
function mockFetch(
  handlers: Record<string, (body: any) => unknown>,
) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const handler = handlers[method];
    if (!handler) {
      return {
        ok: false,
        status: 404,
        text: async () => `No handler for ${method}`,
        json: async () => ({}),
      };
    }
    const body = JSON.parse(init.body as string);
    const result = handler(body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(result),
      json: async () => result,
    };
  });
}

// ---------------------------------------------------------------------------
// URI helper tests
// ---------------------------------------------------------------------------

describe("contents URI helpers", () => {
  it("buildContentsUri creates file URIs", () => {
    const uri = buildContentsUri("http://localhost:9977", "sub/notebook.json", "file");
    expect(uri).toBe("contents://localhost:9977/file/sub%2Fnotebook.json");
  });

  it("buildContentsUri creates directory URIs", () => {
    const uri = buildContentsUri("http://localhost:9977", "sub", "directory");
    expect(uri).toBe("contents://localhost:9977/dir/sub");
  });

  it("buildRootUri creates root directory URI", () => {
    const uri = buildRootUri("http://localhost:9977");
    expect(uri).toBe("contents://localhost:9977/dir/");
  });

  it("parseContentsUri parses file URIs", () => {
    const parsed = parseContentsUri(
      "contents://localhost:9977/file/sub%2Fnotebook.json",
    );
    expect(parsed.baseURL).toBe("http://localhost:9977");
    expect(parsed.kind).toBe("file");
    expect(parsed.relativePath).toBe("sub/notebook.json");
  });

  it("parseContentsUri parses directory URIs", () => {
    const parsed = parseContentsUri("contents://localhost:9977/dir/sub");
    expect(parsed.baseURL).toBe("http://localhost:9977");
    expect(parsed.kind).toBe("directory");
    expect(parsed.relativePath).toBe("sub");
  });

  it("parseContentsUri parses root URI", () => {
    const parsed = parseContentsUri("contents://localhost:9977/dir/");
    expect(parsed.baseURL).toBe("http://localhost:9977");
    expect(parsed.kind).toBe("directory");
    expect(parsed.relativePath).toBe("");
  });

  it("throws on invalid scheme", () => {
    expect(() => parseContentsUri("http://localhost:9977/file/x")).toThrow(
      "Invalid contents URI",
    );
  });

  it("throws on missing kind segment", () => {
    expect(() => parseContentsUri("contents://localhost:9977/blob/x")).toThrow(
      "missing kind segment",
    );
  });

  it("rejects path traversal with '..'", () => {
    expect(() =>
      parseContentsUri("contents://localhost:9977/file/" + encodeURIComponent("../etc/passwd")),
    ).toThrow("path traversal detected");
  });

  it("rejects path traversal with '.'", () => {
    expect(() =>
      parseContentsUri("contents://localhost:9977/file/" + encodeURIComponent("./secret")),
    ).toThrow("path traversal detected");
  });
});

// ---------------------------------------------------------------------------
// ContentsNotebookStore
// ---------------------------------------------------------------------------

describe("ContentsNotebookStore", () => {
  const BASE_URL = "http://localhost:9977";
  let store: ContentsNotebookStore;
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    store = new ContentsNotebookStore(BASE_URL);
  });

  // -------------------------------------------------------------------------
  // getRootUri
  // -------------------------------------------------------------------------

  it("getRootUri returns the root directory URI", () => {
    expect(store.getRootUri()).toBe("contents://localhost:9977/dir/");
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe("list", () => {
    it("returns .json files and directories", async () => {
      fetchMock = mockFetch({
        List: () => ({
          items: [
            { path: "notebook.json", name: "notebook.json", type: "FILE_TYPE_FILE", sizeBytes: "100", lastModifiedUnixMs: "1000", sha256Hex: "" },
            { path: "readme.md", name: "readme.md", type: "FILE_TYPE_FILE", sizeBytes: "50", lastModifiedUnixMs: "1000", sha256Hex: "" },
            { path: "sub", name: "sub", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "1000", sha256Hex: "" },
          ],
        }),
      });
      g.fetch = fetchMock;

      const rootUri = store.getRootUri();
      const items = await store.list(rootUri);

      // readme.md filtered out, folders first
      expect(items).toHaveLength(2);
      expect(items[0].type).toBe(NotebookStoreItemType.Folder);
      expect(items[0].name).toBe("sub");
      expect(items[1].type).toBe(NotebookStoreItemType.File);
      expect(items[1].name).toBe("notebook.json");
    });

    it("sorts folders before files, then alphabetically", async () => {
      fetchMock = mockFetch({
        List: () => ({
          items: [
            { path: "b.json", name: "b.json", type: "FILE_TYPE_FILE", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: "a.json", name: "a.json", type: "FILE_TYPE_FILE", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: "z-dir", name: "z-dir", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: "a-dir", name: "a-dir", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
          ],
        }),
      });
      g.fetch = fetchMock;

      const items = await store.list(store.getRootUri());
      expect(items.map((i) => i.name)).toEqual(["a-dir", "z-dir", "a.json", "b.json"]);
    });

    it("passes correct path to RPC", async () => {
      fetchMock = mockFetch({
        List: () => ({ items: [] }),
      });
      g.fetch = fetchMock;

      const subUri = buildContentsUri(BASE_URL, "my-folder", "directory");
      await store.list(subUri);

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(callBody.path).toBe("my-folder");
    });

    it("throws when given a file URI", async () => {
      const fileUri = buildContentsUri(BASE_URL, "test.json", "file");
      await expect(store.list(fileUri)).rejects.toThrow("expects a directory URI");
    });

    it("sets parent URI on returned items", async () => {
      fetchMock = mockFetch({
        List: () => ({
          items: [
            { path: "test.json", name: "test.json", type: "FILE_TYPE_FILE", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
          ],
        }),
      });
      g.fetch = fetchMock;

      const rootUri = store.getRootUri();
      const items = await store.list(rootUri);
      expect(items[0].parents).toEqual([rootUri]);
    });
  });

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  describe("load", () => {
    it("reads and parses a notebook", async () => {
      const nbJson = makeEmptyNotebookJson();
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(nbJson),
          info: { path: "notebook.json", name: "notebook.json", type: "FILE_TYPE_FILE", sizeBytes: String(nbJson.length), lastModifiedUnixMs: "1000", sha256Hex: "abc123" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const notebook = await store.load(fileUri);

      expect(notebook).toBeDefined();
      expect(notebook.cells).toEqual([]);
    });

    it("records base version hash after load", async () => {
      const nbJson = makeEmptyNotebookJson();
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(nbJson),
          info: { sha256Hex: "deadbeef" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      await store.load(fileUri);

      // The base version is stored internally - we verify by saving and checking
      // that expectedVersion is sent.
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.expectedVersion).toBe("deadbeef");
          return { info: { sha256Hex: "newversion" } };
        },
      });
      g.fetch = fetchMock;

      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await store.save(fileUri, notebook);
    });

    it("throws when given a directory URI", async () => {
      await expect(store.load(store.getRootUri())).rejects.toThrow(
        "expects a file URI",
      );
    });

    it("requests hash from server", async () => {
      const nbJson = makeEmptyNotebookJson();
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(nbJson),
          info: { sha256Hex: "abc" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      await store.load(fileUri);

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(callBody.includeHash).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------

  describe("save", () => {
    it("writes serialized notebook to server", async () => {
      fetchMock = mockFetch({
        Write: (body: any) => {
          const decoded = atob(body.content);
          expect(() => JSON.parse(decoded)).not.toThrow();
          return { info: { sha256Hex: "newhash" } };
        },
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await store.save(fileUri, notebook);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("uses OVERWRITE_ALWAYS mode", async () => {
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.mode).toBe("WRITE_MODE_OVERWRITE_ALWAYS");
          return { info: {} };
        },
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await store.save(fileUri, notebook);
    });

    it("sends expectedVersion when base version exists", async () => {
      // First load to set base version.
      const nbJson = makeEmptyNotebookJson();
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(nbJson),
          info: { sha256Hex: "version1" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      await store.load(fileUri);

      // Now save.
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.expectedVersion).toBe("version1");
          return { info: { sha256Hex: "version2" } };
        },
      });
      g.fetch = fetchMock;

      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await store.save(fileUri, notebook);
    });

    it("updates base version after save", async () => {
      fetchMock = mockFetch({
        Write: () => ({ info: { sha256Hex: "first" } }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await store.save(fileUri, notebook);

      // Second save should use "first" as expectedVersion.
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.expectedVersion).toBe("first");
          return { info: { sha256Hex: "second" } };
        },
      });
      g.fetch = fetchMock;

      await store.save(fileUri, notebook);
    });

    it("throws when given a directory URI", async () => {
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await expect(store.save(store.getRootUri(), notebook)).rejects.toThrow(
        "expects a file URI",
      );
    });

    it("handles server error", async () => {
      g.fetch = vi.fn(async () => ({
        ok: false,
        status: 409,
        text: async () => "version mismatch",
      }));

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await expect(store.save(fileUri, notebook)).rejects.toThrow("failed (409)");
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe("create", () => {
    it("creates a new file with empty notebook content", async () => {
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.path).toBe("new-notebook.json");
          expect(body.mode).toBe("WRITE_MODE_FAIL_IF_EXISTS");
          return { info: { sha256Hex: "newhash" } };
        },
      });
      g.fetch = fetchMock;

      const item = await store.create(store.getRootUri(), "new-notebook.json");

      expect(item.name).toBe("new-notebook.json");
      expect(item.type).toBe(NotebookStoreItemType.File);
      expect(item.parents).toEqual([store.getRootUri()]);
    });

    it("auto-appends .json extension when missing", async () => {
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.path).toBe("my-notebook.json");
          return { info: { sha256Hex: "h" } };
        },
      });
      g.fetch = fetchMock;

      const item = await store.create(store.getRootUri(), "my-notebook");
      expect(item.name).toBe("my-notebook.json");
    });

    it("does not double .json extension", async () => {
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.path).toBe("already.json");
          return { info: {} };
        },
      });
      g.fetch = fetchMock;

      const item = await store.create(store.getRootUri(), "already.json");
      expect(item.name).toBe("already.json");
    });

    it("creates file in subdirectory", async () => {
      fetchMock = mockFetch({
        Write: (body: any) => {
          expect(body.path).toBe("sub/test.json");
          return { info: {} };
        },
      });
      g.fetch = fetchMock;

      const subUri = buildContentsUri(BASE_URL, "sub", "directory");
      const item = await store.create(subUri, "test.json");
      expect(item.name).toBe("test.json");
      expect(item.parents).toEqual([subUri]);
    });

    it("throws when given a file URI as parent", async () => {
      const fileUri = buildContentsUri(BASE_URL, "existing.json", "file");
      await expect(store.create(fileUri, "new.json")).rejects.toThrow(
        "expects a directory URI",
      );
    });
  });

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  describe("rename", () => {
    it("renames a file", async () => {
      fetchMock = mockFetch({
        Rename: (body: any) => {
          expect(body.oldPath).toBe("old.json");
          expect(body.newPath).toBe("new.json");
          return { info: { sha256Hex: "renamed" } };
        },
      });
      g.fetch = fetchMock;

      const oldUri = buildContentsUri(BASE_URL, "old.json", "file");
      const result = await store.rename(oldUri, "new.json");

      expect(result.name).toBe("new.json");
      expect(result.type).toBe(NotebookStoreItemType.File);
    });

    it("preserves parent directory in new path", async () => {
      fetchMock = mockFetch({
        Rename: (body: any) => {
          expect(body.oldPath).toBe("sub/old.json");
          expect(body.newPath).toBe("sub/new.json");
          return { info: {} };
        },
      });
      g.fetch = fetchMock;

      const oldUri = buildContentsUri(BASE_URL, "sub/old.json", "file");
      const result = await store.rename(oldUri, "new.json");

      expect(result.name).toBe("new.json");
      expect(result.parents).toEqual([
        buildContentsUri(BASE_URL, "sub", "directory"),
      ]);
    });

    it("sends expectedVersion when base version exists", async () => {
      // Load first to set base version.
      const nbJson = makeEmptyNotebookJson();
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(nbJson),
          info: { sha256Hex: "v1" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "old.json", "file");
      await store.load(fileUri);

      fetchMock = mockFetch({
        Rename: (body: any) => {
          expect(body.expectedVersion).toBe("v1");
          return { info: { sha256Hex: "v2" } };
        },
      });
      g.fetch = fetchMock;

      await store.rename(fileUri, "new.json");
    });

    it("throws when given a directory URI", async () => {
      await expect(store.rename(store.getRootUri(), "new-name")).rejects.toThrow(
        "expects a file URI",
      );
    });
  });

  // -------------------------------------------------------------------------
  // getMetadata
  // -------------------------------------------------------------------------

  describe("getMetadata", () => {
    it("returns metadata for a file", async () => {
      fetchMock = mockFetch({
        Stat: () => ({
          info: { path: "notebook.json", name: "notebook.json", type: "FILE_TYPE_FILE", sizeBytes: "100", lastModifiedUnixMs: "1000", sha256Hex: "" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const meta = await store.getMetadata(fileUri);

      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("notebook.json");
      expect(meta!.type).toBe(NotebookStoreItemType.File);
      expect(meta!.uri).toBe(fileUri);
    });

    it("returns metadata for a directory", async () => {
      fetchMock = mockFetch({
        Stat: () => ({
          info: { path: "sub", name: "sub", type: "FILE_TYPE_DIRECTORY" },
        }),
      });
      g.fetch = fetchMock;

      const dirUri = buildContentsUri(BASE_URL, "sub", "directory");
      const meta = await store.getMetadata(dirUri);

      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("sub");
      expect(meta!.type).toBe(NotebookStoreItemType.Folder);
    });

    it("returns null on server error", async () => {
      g.fetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => "not found",
      }));

      const fileUri = buildContentsUri(BASE_URL, "nonexistent.json", "file");
      const meta = await store.getMetadata(fileUri);
      expect(meta).toBeNull();
    });

    it("derives parent URI for nested entries", async () => {
      fetchMock = mockFetch({
        Stat: () => ({
          info: { path: "sub/notebook.json", name: "notebook.json", type: "FILE_TYPE_FILE" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "sub/notebook.json", "file");
      const meta = await store.getMetadata(fileUri);

      expect(meta!.parents).toEqual([
        buildContentsUri(BASE_URL, "sub", "directory"),
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // getType
  // -------------------------------------------------------------------------

  describe("getType", () => {
    it("returns File for file URIs", async () => {
      const type = await store.getType(
        buildContentsUri(BASE_URL, "test.json", "file"),
      );
      expect(type).toBe(NotebookStoreItemType.File);
    });

    it("returns Folder for directory URIs", async () => {
      const type = await store.getType(
        buildContentsUri(BASE_URL, "subdir", "directory"),
      );
      expect(type).toBe(NotebookStoreItemType.Folder);
    });
  });

  // -------------------------------------------------------------------------
  // auth headers
  // -------------------------------------------------------------------------

  describe("auth headers", () => {
    it("sends auth headers with requests", async () => {
      const authStore = new ContentsNotebookStore(BASE_URL, async () => ({
        Authorization: "Bearer test-token",
      }));

      fetchMock = mockFetch({
        List: () => ({ items: [] }),
      });
      g.fetch = fetchMock;

      await authStore.list(authStore.getRootUri());

      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
    });
  });
});
