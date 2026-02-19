/// <reference types="vitest" />

import { describe, expect, it } from "vitest";

import { NotebookStoreItemType } from "./notebook";
import { parseDriveItem } from "./drive";

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
