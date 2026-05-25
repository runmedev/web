import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import { parser_pb } from "../../runme/client";
import { NotebookStoreItemType } from "../../storage/notebook";
import type { DriveNotebookStore } from "../../storage/drive";
import type LocalNotebooks from "../../storage/local";
import type { NotebooksApi } from "../runtime/runmeConsole";
import { createNotebookDiffRuntimeApi } from "./runtime";

function notebook(value: string) {
  return create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        refId: "cell-1",
        kind: parser_pb.CellKind.CODE,
        languageId: "python",
        value,
      }),
    ],
    metadata: {},
  });
}

describe("createNotebookDiffRuntimeApi", () => {
  it("computes a diff against a Drive revision for the current local notebook", async () => {
    const notebooksApi = {
      get: vi.fn().mockResolvedValue({
        summary: {
          uri: "local://file/one",
          name: "Notebook",
          isOpen: true,
          source: "local",
        },
        handle: {
          uri: "local://file/one",
          revision: "local-revision",
        },
        notebook: notebook("print('local')"),
      }),
    } as unknown as NotebooksApi;
    const localNotebooks = {
      getMetadata: vi.fn().mockResolvedValue({
        uri: "local://file/one",
        name: "Notebook",
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri: "https://drive.google.com/file/d/drive-file/view",
        parents: [],
      }),
    } as unknown as LocalNotebooks;
    const driveStore = {
      loadRevision: vi.fn().mockResolvedValue(notebook("print('base')")),
    } as unknown as DriveNotebookStore;

    const api = createNotebookDiffRuntimeApi({
      notebooksApi,
      resolveLocalNotebooks: () => localNotebooks,
      resolveDriveNotebookStore: () => driveStore,
    });

    const doc = await api.diffDriveRevision({
      revisionId: "revision-1",
    });

    expect(driveStore.loadRevision).toHaveBeenCalledWith(
      "https://drive.google.com/file/d/drive-file/view",
      "revision-1",
    );
    expect(doc.base.revisionId).toBe("revision-1");
    expect(doc.compare.revisionId).toBe("local-revision");
    expect(doc.diff.summary.sourceChanges).toBe(1);
  });
});

