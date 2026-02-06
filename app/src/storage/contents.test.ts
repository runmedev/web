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
  makeConflictName,
  type MarkdownConverter,
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
    it("returns .json files, .md files, and directories", async () => {
      fetchMock = mockFetch({
        List: () => ({
          items: [
            { path: "notebook.json", name: "notebook.json", type: "FILE_TYPE_FILE", sizeBytes: "100", lastModifiedUnixMs: "1000", sha256Hex: "" },
            { path: "readme.md", name: "readme.md", type: "FILE_TYPE_FILE", sizeBytes: "50", lastModifiedUnixMs: "1000", sha256Hex: "" },
            { path: "data.csv", name: "data.csv", type: "FILE_TYPE_FILE", sizeBytes: "30", lastModifiedUnixMs: "1000", sha256Hex: "" },
            { path: "sub", name: "sub", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "1000", sha256Hex: "" },
          ],
        }),
      });
      g.fetch = fetchMock;

      const rootUri = store.getRootUri();
      const items = await store.list(rootUri);

      // data.csv filtered out, folders first, then .json and .md files
      expect(items).toHaveLength(3);
      expect(items[0].type).toBe(NotebookStoreItemType.Folder);
      expect(items[0].name).toBe("sub");
      expect(items[1].type).toBe(NotebookStoreItemType.File);
      expect(items[1].name).toBe("notebook.json");
      expect(items[2].type).toBe(NotebookStoreItemType.File);
      expect(items[2].name).toBe("readme.md");
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

    it("filters out ignored directories", async () => {
      fetchMock = mockFetch({
        List: () => ({
          items: [
            { path: "node_modules", name: "node_modules", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: ".git", name: ".git", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: "coverage", name: "coverage", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: ".cache", name: ".cache", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: "src", name: "src", type: "FILE_TYPE_DIRECTORY", sizeBytes: "0", lastModifiedUnixMs: "0", sha256Hex: "" },
            { path: "notebook.json", name: "notebook.json", type: "FILE_TYPE_FILE", sizeBytes: "100", lastModifiedUnixMs: "1000", sha256Hex: "" },
          ],
        }),
      });
      g.fetch = fetchMock;

      const items = await store.list(store.getRootUri());
      expect(items).toHaveLength(2);
      expect(items[0].name).toBe("src");
      expect(items[1].name).toBe("notebook.json");
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

    it("throws on non-conflict server error", async () => {
      g.fetch = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "internal server error",
      }));

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await expect(store.save(fileUri, notebook)).rejects.toThrow("failed (500)");
    });

    it("returns non-conflicted result on success", async () => {
      fetchMock = mockFetch({
        Write: () => ({ info: { sha256Hex: "newhash" } }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "notebook.json", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      const result = await store.save(fileUri, notebook);

      expect(result).toEqual({ conflicted: false });
    });

    it("forks on conflict when server returns 409", async () => {
      // Load first to set base version.
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

      // Mock: first Write returns 409, second Write (conflict file) succeeds.
      let writeCount = 0;
      g.fetch = vi.fn(async (url: string, init: RequestInit) => {
        writeCount++;
        if (writeCount === 1) {
          return {
            ok: false,
            status: 409,
            text: async () => "version mismatch",
          };
        }
        // Second Write: conflict file saved successfully.
        const body = JSON.parse(init.body as string);
        expect(body.path).toMatch(/^notebook\.conflict-\d{8}-\d{6}\.json$/);
        expect(body.mode).toBe("WRITE_MODE_FAIL_IF_EXISTS");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ info: { sha256Hex: "conflicthash" } }),
          json: async () => ({ info: { sha256Hex: "conflicthash" } }),
        };
      });

      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      const result = await store.save(fileUri, notebook);

      expect(result.conflicted).toBe(true);
      expect(result.conflictFileName).toMatch(/^notebook\.conflict-\d{8}-\d{6}\.json$/);
    });

    it("forks on conflict preserving parent path for nested files", async () => {
      // Load a nested file to set base version.
      const nbJson = makeEmptyNotebookJson();
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(nbJson),
          info: { sha256Hex: "v1" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "sub/deep/notebook.json", "file");
      await store.load(fileUri);

      let writeCount = 0;
      g.fetch = vi.fn(async (url: string, init: RequestInit) => {
        writeCount++;
        if (writeCount === 1) {
          return { ok: false, status: 409, text: async () => "version mismatch" };
        }
        const body = JSON.parse(init.body as string);
        // Conflict path should preserve the parent directory.
        expect(body.path).toMatch(/^sub\/deep\/notebook\.conflict-\d{8}-\d{6}\.json$/);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ info: { sha256Hex: "ch" } }),
          json: async () => ({ info: { sha256Hex: "ch" } }),
        };
      });

      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      const result = await store.save(fileUri, notebook);

      expect(result.conflicted).toBe(true);
      expect(result.conflictFileName).toMatch(/^notebook\.conflict-\d{8}-\d{6}\.json$/);
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

  // -------------------------------------------------------------------------
  // Markdown support
  // -------------------------------------------------------------------------

  describe("markdown support", () => {
    it("loads .md files via markdownConverter", async () => {
      const mockNotebook = create(parser_pb.NotebookSchema, { cells: [] });
      const converter: MarkdownConverter = {
        deserialize: vi.fn(async () => mockNotebook),
        serialize: vi.fn(async () => new TextEncoder().encode("# test")),
      };
      const mdStore = new ContentsNotebookStore(BASE_URL, undefined, converter);

      const mdContent = "# Hello World";
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(mdContent),
          info: { sha256Hex: "mdhash" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "readme.md", "file");
      const notebook = await mdStore.load(fileUri);

      expect(converter.deserialize).toHaveBeenCalled();
      expect(notebook).toBe(mockNotebook);
    });

    it("saves .md files via markdownConverter", async () => {
      const serializedMd = new TextEncoder().encode("# serialized");
      const converter: MarkdownConverter = {
        deserialize: vi.fn(async () => create(parser_pb.NotebookSchema, { cells: [] })),
        serialize: vi.fn(async () => serializedMd),
      };
      const mdStore = new ContentsNotebookStore(BASE_URL, undefined, converter);

      fetchMock = mockFetch({
        Write: (body: any) => {
          const decoded = atob(body.content);
          expect(decoded).toBe("# serialized");
          return { info: { sha256Hex: "mdhash" } };
        },
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "readme.md", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      const result = await mdStore.save(fileUri, notebook);

      expect(converter.serialize).toHaveBeenCalled();
      expect(result.conflicted).toBe(false);
    });

    it("loads .runme.md files via markdownConverter", async () => {
      const mockNotebook = create(parser_pb.NotebookSchema, { cells: [] });
      const converter: MarkdownConverter = {
        deserialize: vi.fn(async () => mockNotebook),
        serialize: vi.fn(async () => new Uint8Array()),
      };
      const mdStore = new ContentsNotebookStore(BASE_URL, undefined, converter);

      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode("# Runme doc"),
          info: { sha256Hex: "hash" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "setup.runme.md", "file");
      const notebook = await mdStore.load(fileUri);

      expect(converter.deserialize).toHaveBeenCalled();
      expect(notebook).toBe(mockNotebook);
    });

    it("throws when loading .md without markdownConverter", async () => {
      const mdContent = "# Hello";
      fetchMock = mockFetch({
        Read: () => ({
          content: b64encode(mdContent),
          info: { sha256Hex: "hash" },
        }),
      });
      g.fetch = fetchMock;

      const fileUri = buildContentsUri(BASE_URL, "readme.md", "file");
      await expect(store.load(fileUri)).rejects.toThrow(
        "Markdown converter is required",
      );
    });

    it("throws when saving .md without markdownConverter", async () => {
      const fileUri = buildContentsUri(BASE_URL, "readme.md", "file");
      const notebook = create(parser_pb.NotebookSchema, { cells: [] });
      await expect(store.save(fileUri, notebook)).rejects.toThrow(
        "Markdown converter is required",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// makeConflictName
// ---------------------------------------------------------------------------

describe("makeConflictName", () => {
  it("inserts timestamp before file extension", () => {
    const name = makeConflictName("notebook.json");
    expect(name).toMatch(/^notebook\.conflict-\d{8}-\d{6}\.json$/);
  });

  it("handles file with no extension", () => {
    const name = makeConflictName("README");
    expect(name).toMatch(/^README\.conflict-\d{8}-\d{6}$/);
  });

  it("handles file with multiple dots", () => {
    const name = makeConflictName("my.data.json");
    expect(name).toMatch(/^my\.data\.conflict-\d{8}-\d{6}\.json$/);
  });

  it("handles .md extension", () => {
    const name = makeConflictName("readme.md");
    expect(name).toMatch(/^readme\.conflict-\d{8}-\d{6}\.md$/);
  });

  it("handles .runme.md extension (uses last dot)", () => {
    const name = makeConflictName("setup.runme.md");
    // lastIndexOf(".") finds the last dot, so base = "setup.runme", ext = ".md"
    expect(name).toMatch(/^setup\.runme\.conflict-\d{8}-\d{6}\.md$/);
  });
});
