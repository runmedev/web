/// <reference types="vitest" />
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearGoogleDriveRuntime,
  setGoogleDriveBaseUrl,
} from "../lib/googleDriveRuntime";
import { appLogger } from "../lib/logging/runtime";
import {
  encodeIpynbNotebook,
  encodeRunmeNotebook,
} from "../lib/notebookFormat";
import { parser_pb } from "../runme/client";
import {
  DriveCreateNotCommittedError,
  DriveFileCreatedError,
  DriveNotebookStore,
  driveFileUrl,
  driveFolderUrl,
  isDriveItemUri,
  parseDriveItem,
} from "./drive";
import { NotebookStoreItemType } from "./notebook";

function plainIpynb(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: "code",
        id: "plain-cell",
        metadata: {},
        source: "print('hello')",
        outputs: [],
        execution_count: null,
      },
    ],
  });
}

afterEach(() => {
  clearGoogleDriveRuntime();
  vi.restoreAllMocks();
});

describe("parseDriveItem", () => {
  it("extracts id from file share URL", () => {
    const url =
      "https://drive.google.com/file/d/16vfxR6B_nYInoP8O6lfmcfO3lWb2c32y/view?usp=sharing";
    expect(parseDriveItem(url)).toEqual({
      id: "16vfxR6B_nYInoP8O6lfmcfO3lWb2c32y",
      type: NotebookStoreItemType.File,
    });
  });

  it("extracts id from open URL", () => {
    const url = "https://drive.google.com/open?id=1abcDEFghi_JKLmnOPq";
    expect(parseDriveItem(url)).toEqual({
      id: "1abcDEFghi_JKLmnOPq",
      type: NotebookStoreItemType.File,
    });
  });

  it("extracts id from uc download URL", () => {
    const url = "https://drive.google.com/uc?export=download&id=1a2b3c4d5e6f";
    expect(parseDriveItem(url)).toEqual({
      id: "1a2b3c4d5e6f",
      type: NotebookStoreItemType.File,
    });
  });

  it("extracts folder id from folders URL with query", () => {
    const url =
      "https://drive.google.com/drive/folders/1YlKFwhD_rRg4Md5Hm5C6kKgjdiXTfjVx?usp=drive_link";
    expect(parseDriveItem(url)).toEqual({
      id: "1YlKFwhD_rRg4Md5Hm5C6kKgjdiXTfjVx",
      type: NotebookStoreItemType.Folder,
    });
  });

  it("preserves a Drive resource key from a shared link", () => {
    expect(
      parseDriveItem(
        "https://drive.google.com/drive/folders/folder123?resourcekey=key_123",
      ),
    ).toEqual({
      id: "folder123",
      type: NotebookStoreItemType.Folder,
      resourceKey: "key_123",
    });
  });

  it("adds resource keys to canonical Drive URLs", () => {
    expect(driveFolderUrl("folder123", "folder_key")).toBe(
      "https://drive.google.com/drive/folders/folder123?resourcekey=folder_key",
    );
    expect(driveFileUrl("file123", "file_key")).toBe(
      "https://drive.google.com/file/d/file123/view?resourcekey=file_key",
    );
  });

  it("returns the id when raw id provided", () => {
    const id = "0BwwA4oUTeiV1UVNwOHItT0xfa2M";
    expect(parseDriveItem(id)).toEqual({
      id,
      type: NotebookStoreItemType.File,
    });
  });

  it("falls back to the last path segment for generic URLs", () => {
    expect(parseDriveItem("https://example.com/not-drive")).toEqual({
      id: "not-drive",
      type: NotebookStoreItemType.File,
    });
  });
});

describe("isDriveItemUri", () => {
  it("accepts supported Drive URL forms", () => {
    expect(isDriveItemUri("https://drive.google.com/file/d/file123/view")).toBe(
      true,
    );
    expect(
      isDriveItemUri("https://drive.google.com/drive/folders/folder123"),
    ).toBe(true);
    expect(isDriveItemUri("https://drive.google.com/open?id=open123")).toBe(
      true,
    );
    expect(
      isDriveItemUri(
        "https://drive.google.com/uc?export=download&id=download123",
      ),
    ).toBe(true);
  });

  it("rejects local mirror, filesystem, contents, raw id, and generic URL inputs", () => {
    expect(isDriveItemUri("local://file/notebook123")).toBe(false);
    expect(isDriveItemUri("fs://workspace/ws123/file/notebook.json")).toBe(
      false,
    );
    expect(isDriveItemUri("contents://localhost:9977/file/notebook.json")).toBe(
      false,
    );
    expect(isDriveItemUri("0BwwA4oUTeiV1UVNwOHItT0xfa2M")).toBe(false);
    expect(isDriveItemUri("https://example.com/not-drive")).toBe(false);
    expect(isDriveItemUri("https://drive.google.com/not-a-drive-item")).toBe(
      false,
    );
  });
});

describe("DriveNotebookStore", () => {
  it("forwards native Drive files.list search parameters and returns paging metadata", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files");
        expect(url.searchParams.get("q")).toBe(
          "name = 'eval_read.json' and trashed = false",
        );
        expect(url.searchParams.get("corpora")).toBe("drive");
        expect(url.searchParams.get("driveId")).toBe("shared-drive-1");
        expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
        expect(url.searchParams.get("pageSize")).toBe("25");
        expect(url.searchParams.get("pageToken")).toBe("page-1");
        expect(url.searchParams.get("fields")).toBe(
          "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)",
        );
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "file123",
                name: "eval_read.json",
                mimeType: "application/json",
                modifiedTime: "2026-07-02T00:00:00Z",
              },
              {
                id: "folder123",
                name: "Evaluation notebooks",
                mimeType: "application/vnd.google-apps.folder",
              },
              {
                id: "metadata123",
                name: "Metadata without MIME type",
              },
            ],
            nextPageToken: "page-2",
            incompleteSearch: true,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.search({
      q: "name = 'eval_read.json' and trashed = false",
      corpora: "drive",
      driveId: "shared-drive-1",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: "modifiedTime desc",
      pageSize: 25,
      pageToken: "page-1",
      fields:
        "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      files: [
        {
          id: "file123",
          name: "eval_read.json",
          mimeType: "application/json",
          modifiedTime: "2026-07-02T00:00:00Z",
          uri: "https://drive.google.com/file/d/file123/view",
        },
        {
          id: "folder123",
          name: "Evaluation notebooks",
          mimeType: "application/vnd.google-apps.folder",
          uri: "https://drive.google.com/drive/folders/folder123",
        },
        {
          id: "metadata123",
          name: "Metadata without MIME type",
        },
      ],
      nextPageToken: "page-2",
      incompleteSearch: true,
    });
  });

  it("finds a Drive file by its create operation id", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files");
        expect(url.searchParams.get("q")).toBe(
          "'folder123' in parents and trashed = false and appProperties has { key='runmeCreateOperationId' and value='operation-123' }",
        );
        expect(url.searchParams.get("orderBy")).toBe("createdTime asc");
        expect(url.searchParams.get("pageSize")).toBe("2");
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "file123",
                name: "draft.json",
                mimeType: "application/json",
                parents: ["folder123"],
                appProperties: {
                  runmeCreateOperationId: "operation-123",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    await expect(
      store.findByCreateOperation(
        "https://drive.google.com/drive/folders/folder123",
        "operation-123",
      ),
    ).resolves.toMatchObject({
      uri: "https://drive.google.com/file/d/file123/view",
      name: "draft.json",
      type: NotebookStoreItemType.File,
      parents: ["https://drive.google.com/drive/folders/folder123"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("paginates Drive folder listings beyond the first page", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const firstPageFiles = Array.from({ length: 100 }, (_, index) => ({
      id: `dated-${index}`,
      name: `20260715_notebook_${index}.json`,
      mimeType: "application/json",
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files");
        expect(url.searchParams.get("q")).toBe(
          "'folder123' in parents and trashed = false",
        );
        expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("orderBy")).toBe("name");
        expect(url.searchParams.get("pageSize")).toBe("1000");
        expect(url.searchParams.get("fields")).toBe(
          "nextPageToken,files(id,name,mimeType,resourceKey)",
        );
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("folder123/folder-key");

        const pageToken = url.searchParams.get("pageToken");
        const body = pageToken
          ? {
              files: [
                {
                  id: "oncall-guide",
                  name: "oncall_guide.json",
                  mimeType: "application/json",
                  resourceKey: "file-key",
                },
              ],
            }
          : { files: firstPageFiles, nextPageToken: "page-2" };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.list(
      "https://drive.google.com/drive/folders/folder123?resourcekey=folder-key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("pageToken"),
    ).toBeNull();
    expect(
      new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("pageToken"),
    ).toBe("page-2");
    expect(result).toHaveLength(101);
    expect(result.at(-1)).toMatchObject({
      uri: "https://drive.google.com/file/d/oncall-guide/view?resourcekey=file-key",
      name: "oncall_guide.json",
      type: NotebookStoreItemType.File,
    });
  });

  it("creates arbitrary Drive content with the provided MIME type", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/drive/v3/files") {
          expect(init?.method).toBe("POST");
          expect(
            new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
          ).toBe("folder123/folder-key");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            id: "reserved-file123",
            name: "diagram.excalidraw",
            mimeType: "application/vnd.excalidraw+json",
            parents: ["folder123"],
            appProperties: {
              runmeCreateOperationId: "operation-123",
              runmeCreateExpectedChecksum: "expected-checksum",
              runmeCreateExpectedRequest: "expected-request",
            },
          });
          return new Response(
            JSON.stringify({
              id: "reserved-file123",
              name: "diagram.excalidraw",
              mimeType: "application/vnd.excalidraw+json",
              parents: ["folder123"],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.pathname === "/upload/drive/v3/files/reserved-file123") {
          expect(init?.method).toBe("PATCH");
          expect(init?.headers).toMatchObject({
            "Content-Type": "application/vnd.excalidraw+json",
          });
          expect(init?.body).toBe('{"type":"excalidraw"}');
          return new Response("", { status: 200 });
        }
        throw new Error(`Unexpected Drive request: ${url.toString()}`);
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.createContent(
      "https://drive.google.com/drive/folders/folder123?resourcekey=folder-key",
      "diagram.excalidraw",
      '{"type":"excalidraw"}',
      "application/vnd.excalidraw+json",
      {
        createOperationId: "operation-123",
        expectedContentChecksum: "expected-checksum",
        expectedRequestFingerprint: "expected-request",
        fileId: "reserved-file123",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/file/d/reserved-file123/view",
      name: "diagram.excalidraw",
      type: NotebookStoreItemType.File,
      remoteUri: "https://drive.google.com/file/d/reserved-file123/view",
      mimeType: "application/vnd.excalidraw+json",
    });
  });

  it("reserves a Drive file id before creating content", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ids: ["reserved-file123"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const store = new DriveNotebookStore(async () => "access-token");

    await expect(store.generateFileId()).resolves.toBe("reserved-file123");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/drive/v3/files/generateIds?"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates notebooks under protected Drive folders", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/drive/v3/files") {
          expect(init?.method).toBe("POST");
          expect(
            new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
          ).toBe("folder123/folder-key");
          return new Response(
            JSON.stringify({
              id: "notebook123",
              name: "notebook.json",
              mimeType: "application/json",
              parents: ["folder123"],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        expect(url.pathname).toBe("/upload/drive/v3/files/notebook123");
        expect(init?.method).toBe("PATCH");
        return new Response("", { status: 200 });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    await expect(
      store.create(
        "https://drive.google.com/drive/folders/folder123?resourcekey=folder-key",
        "notebook.json",
      ),
    ).resolves.toMatchObject({
      uri: "https://drive.google.com/file/d/notebook123/view",
      parents: [
        "https://drive.google.com/drive/folders/folder123?resourcekey=folder-key",
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not use pre-generated file ids inside a Shared Drive", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ driveId: "shared-drive-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const store = new DriveNotebookStore(async () => "access-token");
    const folderUri = "https://drive.google.com/drive/folders/folder123";

    await expect(store.canUsePreGeneratedFileId(folderUri)).resolves.toBe(
      false,
    );
    await expect(store.canUsePreGeneratedFileId(folderUri)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits for Drive search indexing before declaring an operation absent", async () => {
    vi.useFakeTimers();
    try {
      const store = new DriveNotebookStore(async () => "access-token");
      const indexed = {
        uri: "https://drive.google.com/file/d/existing123/view",
        name: "existing.json",
        type: NotebookStoreItemType.File,
        children: [],
        parents: ["https://drive.google.com/drive/folders/folder123"],
      };
      vi.spyOn(store, "findByCreateOperation")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(indexed);

      const pending = store.waitForCreateOperation(
        "https://drive.google.com/drive/folders/folder123",
        "operation-123",
        100,
      );
      await vi.advanceTimersByTimeAsync(850);

      await expect(pending).resolves.toEqual(indexed);
      expect(store.findByCreateOperation).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a rejected metadata create as definitely not committed", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    );

    const store = new DriveNotebookStore(async () => "access-token");

    await expect(
      store.createContent(
        "https://drive.google.com/drive/folders/folder123",
        "notebook.ipynb",
        "{}",
        "application/x-ipynb+json",
      ),
    ).rejects.toBeInstanceOf(DriveCreateNotCommittedError);
  });

  it.each([
    ["notebook create", "create"],
    ["arbitrary content create", "createContent"],
    ["folder create", "createFolder"],
  ] as const)(
    "explains the Shared drive requirement after a service-account %s failure",
    async (_description, method) => {
      setGoogleDriveBaseUrl("https://drive.example.test");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Service Accounts do not have storage quota.",
              errors: [
                {
                  reason: "storageQuotaExceeded",
                  message: "Service Accounts do not have storage quota.",
                },
              ],
            },
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      const store = new DriveNotebookStore(async () => "access-token");
      const parent = "https://drive.google.com/drive/folders/folder123";
      const create =
        method === "create"
          ? store.create(parent, "notebook.ipynb")
          : method === "createContent"
            ? store.createContent(
                parent,
                "notebook.ipynb",
                "{}",
                "application/x-ipynb+json",
              )
            : store.createFolder(parent, "new-folder");

      await expect(create).rejects.toThrow(
        "service accounts do not have storage quota",
      );
      await expect(create).rejects.toThrow("Choose a folder in a Shared drive");
      await expect(create).rejects.toThrow(
        "A folder shared from a user's My Drive is not a Shared drive",
      );
    },
  );

  it("reports the created file when its initial content upload fails", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/drive/v3/files") {
        return new Response(
          JSON.stringify({
            id: "file123",
            name: "notebook.ipynb",
            headRevisionId: "metadata-revision",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.pathname === "/upload/drive/v3/files/file123") {
        return new Response("Unavailable", { status: 503 });
      }
      throw new Error(`Unexpected Drive request: ${url.toString()}`);
    });

    const store = new DriveNotebookStore(async () => "access-token");
    let failure: unknown;
    try {
      await store.createContent(
        "https://drive.google.com/drive/folders/folder123",
        "notebook.ipynb",
        "{}",
        "application/x-ipynb+json",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DriveFileCreatedError);
    expect(failure).toMatchObject({
      fileId: "file123",
      fileName: "notebook.ipynb",
      creationRevisionId: "metadata-revision",
    });
  });

  it("marks an uploaded create operation complete without dropping its properties", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files/file123");
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({
              appProperties: {
                runmeCreateOperationId: "operation-123",
                runmeCreateExpectedChecksum: "expected-checksum",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          appProperties: {
            runmeCreateOperationId: "operation-123",
            runmeCreateExpectedChecksum: "expected-checksum",
            runmeCreateCompletedChecksum: "expected-checksum",
          },
        });
        return new Response(JSON.stringify({ id: "file123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    await store.markCreateOperationComplete(
      "https://drive.google.com/file/d/file123/view",
      "expected-checksum",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("repairs content only when the checked Drive version still matches", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("resourceKey")).toBe("file-key");
        if (init?.method === "GET") {
          expect(url.pathname).toBe("/drive/v3/files/file123");
          return new Response(
            JSON.stringify({
              md5Checksum: "empty-checksum",
              headRevisionId: "empty-revision",
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                ETag: '"drive-etag-1"',
              },
            },
          );
        }
        expect(url.pathname).toBe("/upload/drive/v3/files/file123");
        expect(init?.method).toBe("PATCH");
        expect(init?.headers).toMatchObject({
          "Content-Type": "application/json",
          "If-Match": '"drive-etag-1"',
        });
        expect(init?.body).toBe('{"cells":[]}');
        return new Response("", { status: 200 });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    await expect(
      store.saveContentIfVersion(
        "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
        '{"cells":[]}',
        "application/json",
        { checksum: "empty-checksum", revisionId: "empty-revision" },
      ),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a repair when Drive changes during the conditional upload", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({
              md5Checksum: "empty-checksum",
              headRevisionId: "empty-revision",
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                ETag: '"drive-etag-1"',
              },
            },
          );
        }
        return new Response("precondition failed", { status: 412 });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    await expect(
      store.saveContentIfVersion(
        "https://drive.google.com/file/d/file123/view",
        '{"cells":[]}',
        "application/json",
        { checksum: "empty-checksum", revisionId: "empty-revision" },
      ),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loads arbitrary Drive file content as text", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/drive/v3/files/file123");
      expect(url.searchParams.get("alt")).toBe("media");
      expect(url.searchParams.get("resourceKey")).toBe("file-key");
      return new Response('{"type":"excalidraw"}', {
        status: 200,
        headers: { "Content-Type": "application/vnd.excalidraw+json" },
      });
    });

    const store = new DriveNotebookStore(async () => "access-token");
    await expect(
      store.loadContent(
        "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      ),
    ).resolves.toBe('{"type":"excalidraw"}');
  });

  it("propagates a resource key through protected notebook saves", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("resourceKey")).toBe("file-key");
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({
              md5Checksum:
                fetchMock.mock.calls.length === 1
                  ? "original-checksum"
                  : "updated-checksum",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.pathname === "/drive/v3/files/file123") {
          expect(init?.method).toBe("PATCH");
          return new Response(JSON.stringify({ id: "file123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        expect(url.pathname).toBe("/upload/drive/v3/files/file123");
        expect(init?.method).toBe("PATCH");
        return new Response("", { status: 200 });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const notebook = create(parser_pb.NotebookSchema, { cells: [] });
    await expect(
      store.save(
        "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
        notebook,
      ),
    ).resolves.toEqual({ conflicted: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("uses shared drive name for shared drive root folder metadata", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/drive/v3/files/drive123") {
          expect(url.searchParams.get("supportsAllDrives")).toBe("true");
          expect(url.searchParams.get("fields")).toBe(
            "id,name,mimeType,parents,driveId,resourceKey",
          );
          return new Response(
            JSON.stringify({
              id: "drive123",
              name: "Drive",
              mimeType: "application/vnd.google-apps.folder",
              driveId: "drive123",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.pathname === "/drive/v3/drives/drive123") {
          expect(url.searchParams.get("fields")).toBe("id,name");
          return new Response(
            JSON.stringify({
              id: "drive123",
              name: "runme-testing",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected Drive request: ${url.toString()}`);
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.getMetadata(
      "https://drive.google.com/drive/folders/drive123",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/drive/folders/drive123",
      name: "runme-testing",
      type: NotebookStoreItemType.Folder,
      remoteUri: "https://drive.google.com/drive/folders/drive123",
    });
  });

  it("creates Drive folders with the folder MIME type", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("fields")).toBe("id,name,mimeType,parents");
        expect(init?.method).toBe("POST");
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("parent123/parent-key");
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "Reports",
          mimeType: "application/vnd.google-apps.folder",
          parents: ["parent123"],
        });
        return new Response(
          JSON.stringify({
            id: "folder123",
            name: "Reports",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["parent123"],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.createFolder(
      "https://drive.google.com/drive/folders/parent123?resourcekey=parent-key",
      "Reports",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      uri: "https://drive.google.com/drive/folders/folder123",
      name: "Reports",
      type: NotebookStoreItemType.Folder,
      children: [],
      remoteUri: "https://drive.google.com/drive/folders/folder123",
      mimeType: "application/vnd.google-apps.folder",
      parents: [
        "https://drive.google.com/drive/folders/parent123?resourcekey=parent-key",
      ],
    });
  });

  it("renames Drive files through the metadata update API", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files/file123");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("resourceKey")).toBe("file-key");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "renamed.json",
        });
        return new Response(
          JSON.stringify({
            id: "file123",
            name: "renamed.json",
            mimeType: "application/json",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.rename(
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      "renamed.json",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      name: "renamed.json",
      type: NotebookStoreItemType.File,
      remoteUri:
        "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
    });
  });

  it("renames Drive folders through the metadata update API", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files/folder123");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "Renamed Folder",
        });
        return new Response(
          JSON.stringify({
            id: "folder123",
            name: "Renamed Folder",
            mimeType: "application/vnd.google-apps.folder",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.rename(
      "https://drive.google.com/drive/folders/folder123",
      "Renamed Folder",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/drive/folders/folder123",
      name: "Renamed Folder",
      type: NotebookStoreItemType.Folder,
      remoteUri: "https://drive.google.com/drive/folders/folder123",
    });
  });

  it("moves Drive items between folders through the parent update API", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files/file123");
        expect(url.searchParams.get("addParents")).toBe("destination123");
        expect(url.searchParams.get("removeParents")).toBe("source123");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("resourceKey")).toBe("file-key");
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("source123/source-key,destination123/destination-key");
        expect(init?.method).toBe("PATCH");
        expect(init?.body).toBeUndefined();
        return new Response(
          JSON.stringify({
            id: "file123",
            name: "notebook.json",
            mimeType: "application/json",
            parents: ["destination123"],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.move(
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      "https://drive.google.com/drive/folders/source123?resourcekey=source-key",
      "https://drive.google.com/drive/folders/destination123?resourcekey=destination-key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      uri: "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      name: "notebook.json",
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri:
        "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      mimeType: "application/json",
      parents: [
        "https://drive.google.com/drive/folders/destination123?resourcekey=destination-key",
      ],
    });
  });

  it("moves Drive files to trash through the metadata update API", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files/file123");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("resourceKey")).toBe("file-key");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          trashed: true,
        });
        return new Response(
          JSON.stringify({
            id: "file123",
            name: "untitled.json",
            mimeType: "application/json",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const result = await store.moveToTrash(
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      name: "untitled.json",
      type: NotebookStoreItemType.File,
      remoteUri:
        "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
    });
  });

  it("paginates Drive revisions", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("file123/file-key");
        const pageToken = url.searchParams.get("pageToken");
        const body = pageToken
          ? { revisions: [{ id: "revision-2", size: "20" }] }
          : {
              revisions: [{ id: "revision-1", size: "10" }],
              nextPageToken: "next-page",
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const revisions = await store.listRevisions(
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
    );

    expect(revisions.map((revision) => revision.id)).toEqual([
      "revision-1",
      "revision-2",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("pageToken"),
    ).toBe("next-page");
  });

  it("paginates Drive comments", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("file123/file-key");
        expect(url.pathname).toBe("/drive/v3/files/file123/comments");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("includeDeleted")).toBe("true");
        const pageToken = url.searchParams.get("pageToken");
        const body = pageToken
          ? { comments: [{ id: "comment-2", content: "second" }] }
          : {
              comments: [{ id: "comment-1", content: "first" }],
              nextPageToken: "next-page",
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const comments = await store.listComments(
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
    );

    expect(comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-2",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("pageToken"),
    ).toBe("next-page");
  });

  it("creates anchored Drive comments", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files/file123/comments");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("file123/file-key");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          content: "Please check this",
          anchor: '{"runme":{"kind":"cell","cellId":"cell-1"}}',
        });
        return new Response(
          JSON.stringify({
            id: "comment-1",
            content: "Please check this",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const comment = await store.createComment(
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      " Please check this ",
      '{"runme":{"kind":"cell","cellId":"cell-1"}}',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(comment.id).toBe("comment-1");
  });

  it("creates range comments with reviewed content", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          content: "Clarify this text",
          anchor: "range-anchor",
          quotedFileContent: {
            mimeType: "text/plain",
            value: "migration guide",
          },
        });
        return new Response(
          JSON.stringify({ id: "comment-range", content: "Clarify this text" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    await store.createComment(
      "https://drive.google.com/file/d/file123/view",
      "Clarify this text",
      {
        anchor: "range-anchor",
        quotedFileContent: {
          mimeType: "text/plain",
          value: "migration guide",
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves Drive comments through replies", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe(
          "/drive/v3/files/file123/comments/comment-1/replies",
        );
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("file123/file-key");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          action: "resolve",
        });
        return new Response(
          JSON.stringify({ id: "reply-1", action: "resolve" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const reply = await store.resolveComment(
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key",
      "comment-1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reply.action).toBe("resolve");
  });

  it("loads protected Drive revision notebooks and raw content", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe(
          "/drive/v3/files/file123/revisions/revision-1",
        );
        expect(
          new Headers(init?.headers).get("X-Goog-Drive-Resource-Keys"),
        ).toBe("file123/file-key");
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const uri =
      "https://drive.google.com/file/d/file123/view?resourcekey=file-key";
    await expect(store.loadRevision(uri, "revision-1")).resolves.toBeTruthy();
    await expect(store.loadRevisionContent(uri, "revision-1")).resolves.toBe(
      "{}",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("decodes IPYNB revisions using the supplied filename without warning", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const source = create(parser_pb.NotebookSchema, {
      metadata: { owner: "runme" },
      cells: [
        create(parser_pb.CellSchema, {
          refId: "cell-1",
          kind: parser_pb.CellKind.CODE,
          languageId: "bash",
          value: "echo hello",
          metadata: { name: "hello", "runme.dev/runnerName": "local" },
        }),
      ],
    });
    const ipynb = encodeIpynbNotebook(source).text;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(ipynb, {
        status: 200,
        headers: { "Content-Type": "application/x-ipynb+json" },
      }),
    );
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => null as never);

    const store = new DriveNotebookStore(async () => "access-token");
    const loaded = await store.loadRevision(
      "https://drive.google.com/file/d/file123/view",
      "revision-1",
      "notebook.ipynb",
    );

    expect(loaded.metadata.owner).toBe("runme");
    expect(loaded.cells).toHaveLength(1);
    expect(loaded.cells[0]?.metadata).toMatchObject({
      name: "hello",
      "runme.dev/runnerName": "local",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to IPYNB decoding with a structured warning", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const source = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: "cell-1",
          kind: parser_pb.CellKind.MARKUP,
          languageId: "markdown",
          value: "# Hello",
          metadata: { name: "hello" },
        }),
      ],
    });
    const ipynb = encodeIpynbNotebook(source).text;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(ipynb, {
        status: 200,
        headers: { "Content-Type": "application/x-ipynb+json" },
      }),
    );
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => null as never);

    const store = new DriveNotebookStore(async () => "access-token");
    const loaded = await store.loadRevision(
      "https://drive.google.com/file/d/file123/view",
      "revision-1",
    );

    expect(loaded.cells[0]?.value).toBe("# Hello");
    expect(warn).toHaveBeenCalledWith(
      "Recovered Drive revision with IPYNB shape fallback",
      {
        attrs: {
          scope: "storage.drive.revision",
          code: "DRIVE_REVISION_IPYNB_DECODE_FALLBACK",
          initialFormat: "runme-json",
          cellCount: 1,
          cellsWithObjectRunmeMetadata: 1,
          notebookRunmeMetadataType: "object",
        },
      },
    );
  });

  it("detects plain Jupyter revisions before protobuf decoding", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(plainIpynb(), {
        status: 200,
        headers: { "Content-Type": "application/x-ipynb+json" },
      }),
    );
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => null as never);

    const store = new DriveNotebookStore(async () => "access-token");
    const loaded = await store.loadRevision(
      "https://drive.google.com/file/d/file123/view",
      "revision-1",
    );

    expect(loaded.cells).toHaveLength(1);
    expect(loaded.cells[0]?.value).toBe("print('hello')");
    expect(warn).toHaveBeenCalledWith(
      "Recovered Drive revision with IPYNB shape fallback",
      {
        attrs: {
          scope: "storage.drive.revision",
          code: "DRIVE_REVISION_IPYNB_DECODE_FALLBACK",
          initialFormat: "runme-json",
          cellCount: 1,
          cellsWithObjectRunmeMetadata: 0,
          notebookRunmeMetadataType: "undefined",
        },
      },
    );
  });

  it("prefers revision IPYNB shape over the current JSON filename", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(plainIpynb(), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => null as never);

    const store = new DriveNotebookStore(async () => "access-token");
    const loaded = await store.loadRevision(
      "https://drive.google.com/file/d/file123/view",
      "revision-1",
      "notebook.json",
    );

    expect(loaded.cells).toHaveLength(1);
    expect(loaded.cells[0]?.value).toBe("print('hello')");
    expect(warn).toHaveBeenCalledWith(
      "Recovered Drive revision with IPYNB shape fallback",
      {
        attrs: {
          scope: "storage.drive.revision",
          code: "DRIVE_REVISION_IPYNB_DECODE_FALLBACK",
          initialFormat: "runme-json",
          cellCount: 1,
          cellsWithObjectRunmeMetadata: 0,
          notebookRunmeMetadataType: "undefined",
        },
      },
    );
  });

  it("prefers revision Runme JSON shape over the current IPYNB filename", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const source = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: "cell-1",
          kind: parser_pb.CellKind.CODE,
          languageId: "bash",
          value: "echo hello",
          metadata: { name: "hello" },
        }),
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(encodeRunmeNotebook(source), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => null as never);

    const store = new DriveNotebookStore(async () => "access-token");
    const loaded = await store.loadRevision(
      "https://drive.google.com/file/d/file123/view",
      "revision-1",
      "notebook.ipynb",
    );

    expect(loaded.cells).toHaveLength(1);
    expect(loaded.cells[0]?.value).toBe("echo hello");
    expect(warn).toHaveBeenCalledWith(
      "Recovered Drive revision with Runme JSON shape fallback",
      {
        attrs: {
          scope: "storage.drive.revision",
          code: "DRIVE_REVISION_RUNME_JSON_DECODE_FALLBACK",
          initialFormat: "ipynb",
          cellCount: 1,
        },
      },
    );
  });

  it.each(["{}", '{"cells":[]}'])(
    "recognizes default-omitting Runme JSON under the current IPYNB filename: %s",
    async (body) => {
      setGoogleDriveBaseUrl("https://drive.example.test");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const warn = vi
        .spyOn(appLogger, "warn")
        .mockImplementation(() => null as never);

      const store = new DriveNotebookStore(async () => "access-token");
      const loaded = await store.loadRevision(
        "https://drive.google.com/file/d/file123/view",
        "revision-1",
        "notebook.ipynb",
      );

      expect(loaded.cells).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        "Recovered Drive revision with Runme JSON shape fallback",
        {
          attrs: {
            scope: "storage.drive.revision",
            code: "DRIVE_REVISION_RUNME_JSON_DECODE_FALLBACK",
            initialFormat: "ipynb",
            cellCount: 0,
          },
        },
      );
    },
  );

  it("does not reinterpret invalid Runme JSON as IPYNB", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"metadata":{"runme":{"unexpected":true}}}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warn = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => null as never);

    const store = new DriveNotebookStore(async () => "access-token");
    await expect(
      store.loadRevision(
        "https://drive.google.com/file/d/file123/view",
        "revision-1",
      ),
    ).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
