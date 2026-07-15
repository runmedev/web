/// <reference types="vitest" />

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearGoogleDriveRuntime,
  setGoogleDriveBaseUrl,
} from "../lib/googleDriveRuntime";
import { NotebookStoreItemType } from "./notebook";
import { DriveNotebookStore, isDriveItemUri, parseDriveItem } from "./drive";

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
    expect(isDriveItemUri("https://drive.google.com/file/d/file123/view")).toBe(true);
    expect(isDriveItemUri("https://drive.google.com/drive/folders/folder123")).toBe(true);
    expect(isDriveItemUri("https://drive.google.com/open?id=open123")).toBe(true);
    expect(isDriveItemUri("https://drive.google.com/uc?export=download&id=download123")).toBe(true);
  });

  it("rejects local mirror, filesystem, contents, raw id, and generic URL inputs", () => {
    expect(isDriveItemUri("local://file/notebook123")).toBe(false);
    expect(isDriveItemUri("fs://workspace/ws123/file/notebook.json")).toBe(false);
    expect(isDriveItemUri("contents://localhost:9977/file/notebook.json")).toBe(false);
    expect(isDriveItemUri("0BwwA4oUTeiV1UVNwOHItT0xfa2M")).toBe(false);
    expect(isDriveItemUri("https://example.com/not-drive")).toBe(false);
    expect(isDriveItemUri("https://drive.google.com/not-a-drive-item")).toBe(false);
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

  it("creates arbitrary Drive content with the provided MIME type", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/drive/v3/files") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            name: "diagram.excalidraw",
            mimeType: "application/vnd.excalidraw+json",
            parents: ["folder123"],
          });
          return new Response(
            JSON.stringify({
              id: "file123",
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
        if (url.pathname === "/upload/drive/v3/files/file123") {
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
      "https://drive.google.com/drive/folders/folder123",
      "diagram.excalidraw",
      '{"type":"excalidraw"}',
      "application/vnd.excalidraw+json",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/file/d/file123/view",
      name: "diagram.excalidraw",
      type: NotebookStoreItemType.File,
      remoteUri: "https://drive.google.com/file/d/file123/view",
      mimeType: "application/vnd.excalidraw+json",
    });
  });

  it("loads arbitrary Drive file content as text", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/drive/v3/files/file123");
      expect(url.searchParams.get("alt")).toBe("media");
      return new Response('{"type":"excalidraw"}', {
        status: 200,
        headers: { "Content-Type": "application/vnd.excalidraw+json" },
      });
    });

    const store = new DriveNotebookStore(async () => "access-token");
    await expect(
      store.loadContent("https://drive.google.com/file/d/file123/view"),
    ).resolves.toBe('{"type":"excalidraw"}');
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
            "id,name,mimeType,parents,driveId",
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
      "https://drive.google.com/drive/folders/parent123",
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
      parents: ["https://drive.google.com/drive/folders/parent123"],
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
      "https://drive.google.com/file/d/file123/view",
      "renamed.json",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/file/d/file123/view",
      name: "renamed.json",
      type: NotebookStoreItemType.File,
      remoteUri: "https://drive.google.com/file/d/file123/view",
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
      "https://drive.google.com/file/d/file123/view",
      "https://drive.google.com/drive/folders/source123",
      "https://drive.google.com/drive/folders/destination123",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      uri: "https://drive.google.com/file/d/file123/view",
      name: "notebook.json",
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: "https://drive.google.com/file/d/file123/view",
      mimeType: "application/json",
      parents: ["https://drive.google.com/drive/folders/destination123"],
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
      "https://drive.google.com/file/d/file123/view",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      uri: "https://drive.google.com/file/d/file123/view",
      name: "untitled.json",
      type: NotebookStoreItemType.File,
      remoteUri: "https://drive.google.com/file/d/file123/view",
    });
  });

  it("paginates Drive revisions", async () => {
    setGoogleDriveBaseUrl("https://drive.example.test");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
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
      "https://drive.google.com/file/d/file123/view",
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
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/drive/v3/files/file123/comments");
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("includeDeleted")).toBe("false");
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
      "https://drive.google.com/file/d/file123/view",
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
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          content: "Please check this",
          anchor: "{\"runme\":{\"kind\":\"cell\",\"cellId\":\"cell-1\"}}",
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
      "https://drive.google.com/file/d/file123/view",
      " Please check this ",
      "{\"runme\":{\"kind\":\"cell\",\"cellId\":\"cell-1\"}}",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(comment.id).toBe("comment-1");
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
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          action: "resolve",
        });
        return new Response(JSON.stringify({ id: "reply-1", action: "resolve" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const store = new DriveNotebookStore(async () => "access-token");
    const reply = await store.resolveComment(
      "https://drive.google.com/file/d/file123/view",
      "comment-1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reply.action).toBe("resolve");
  });
});
