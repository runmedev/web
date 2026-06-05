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
});
