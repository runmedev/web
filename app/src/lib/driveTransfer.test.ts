import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";

import { appState } from "./runtime/AppState";
import {
  copyDriveNotebookFile,
  createDriveFile,
  listDriveFolderItems,
  saveNotebookAsDriveCopy,
  updateDriveFileBytes,
} from "./driveTransfer";
import { parser_pb } from "../runme/client";
import { NotebookStoreItemType } from "../storage/notebook";

afterEach(() => {
  vi.restoreAllMocks();
  appState.setDriveNotebookStore(null);
  appState.setLocalNotebooks(null);
  appState.setOpenNotebookHandler(null);
});

describe("driveTransfer", () => {
  it("creates a drive file and returns parsed id", async () => {
    const create = vi.fn().mockResolvedValue({
      uri: "https://drive.google.com/file/d/abc123/view",
    });
    appState.setDriveNotebookStore({ create } as any);

    const id = await createDriveFile("folder123", "notes.md");
    expect(id).toBe("abc123");
    expect(create).toHaveBeenCalledWith(
      "https://drive.google.com/drive/folders/folder123",
      "notes.md",
    );
  });

  it("updates drive file bytes using saveContent", async () => {
    const saveContent = vi.fn().mockResolvedValue(undefined);
    appState.setDriveNotebookStore({ saveContent } as any);

    const id = await updateDriveFileBytes(
      "abc123",
      new TextEncoder().encode("hello"),
    );

    expect(id).toBe("abc123");
    expect(saveContent).toHaveBeenCalledWith(
      "https://drive.google.com/file/d/abc123/view",
      "hello",
      "text/markdown",
    );
  });

  it("lists drive folder items", async () => {
    const list = vi.fn().mockResolvedValue([
      {
        uri: "https://drive.google.com/file/d/abc123/view",
        name: "abc123.json",
        type: NotebookStoreItemType.File,
        children: [],
        parents: [],
      },
    ]);
    appState.setDriveNotebookStore({ list } as any);

    const items = await listDriveFolderItems("folder123");

    expect(list).toHaveBeenCalledWith(
      "https://drive.google.com/drive/folders/folder123",
    );
    expect(items).toHaveLength(1);
  });

  it("copies a notebook file to another drive folder", async () => {
    const sourceUri = "https://drive.google.com/file/d/src123/view";
    const destinationUri = "https://drive.google.com/file/d/copied123/view";
    const notebook = create(parser_pb.NotebookSchema, { cells: [] });
    const getMetadata = vi.fn().mockResolvedValue({
      uri: sourceUri,
      name: "source.json",
      type: NotebookStoreItemType.File,
      children: [],
      parents: [],
    });
    const load = vi.fn().mockResolvedValue(notebook);
    const createRemote = vi.fn().mockResolvedValue({ uri: destinationUri });
    const save = vi.fn().mockResolvedValue({ conflicted: false });
    appState.setDriveNotebookStore({
      getMetadata,
      load,
      create: createRemote,
      save,
    } as any);

    const result = await copyDriveNotebookFile("src123", "folder999");

    expect(getMetadata).toHaveBeenCalledWith(sourceUri);
    expect(load).toHaveBeenCalledWith(sourceUri);
    expect(createRemote).toHaveBeenCalledWith(
      "https://drive.google.com/drive/folders/folder999",
      "source.json",
    );
    expect(save).toHaveBeenCalledWith(destinationUri, notebook);
    expect(result).toEqual({
      fileId: "copied123",
      fileName: "source.json",
      sourceUri,
      targetUri: destinationUri,
    });
  });

  it("saves a notebook as a drive copy, mirrors locally, and switches current doc", async () => {
    const createRemote = vi.fn().mockResolvedValue({
      uri: "https://drive.google.com/file/d/drive123/view",
    });
    const saveContent = vi.fn().mockResolvedValue(undefined);
    appState.setDriveNotebookStore({ create: createRemote, saveContent } as any);

    const addFile = vi.fn().mockResolvedValue("local://file/new-copy");
    const saveLocal = vi.fn().mockResolvedValue(undefined);
    appState.setLocalNotebooks({ addFile, save: saveLocal } as any);

    const openNotebook = vi.fn().mockResolvedValue(undefined);
    appState.setOpenNotebookHandler(openNotebook);

    const notebook = create(parser_pb.NotebookSchema, { cells: [] });

    const result = await saveNotebookAsDriveCopy(
      notebook,
      "folder123",
      "copy.json",
    );

    expect(result.fileId).toBe("drive123");
    expect(result.remoteUri).toBe("https://drive.google.com/file/d/drive123/view");
    expect(result.localUri).toBe("local://file/new-copy");
    expect(addFile).toHaveBeenCalledWith(result.remoteUri, "copy.json");
    expect(saveLocal).toHaveBeenCalledWith("local://file/new-copy", notebook);
    expect(openNotebook).toHaveBeenCalledWith("local://file/new-copy");
    expect(saveContent).toHaveBeenCalledWith(
      "https://drive.google.com/file/d/drive123/view",
      expect.any(String),
      "application/json",
    );
  });
});
