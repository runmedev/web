import { describe, expect, it } from "vitest";

import { NotebookStoreItemType } from "../../storage/notebook";
import { filterMountedWorkspaceFolderChildren } from "./workspaceTree";

describe("filterMountedWorkspaceFolderChildren", () => {
  it("omits folders that are also explicit workspace roots", () => {
    const children = [
      {
        uri: "local://folder/nested",
        type: NotebookStoreItemType.Folder,
      },
      {
        uri: "local://folder/ordinary",
        type: NotebookStoreItemType.Folder,
      },
      {
        uri: "local://file/notebook",
        type: NotebookStoreItemType.File,
      },
    ];
    const mountedUris = new Set(["local://folder/nested"]);

    expect(
      filterMountedWorkspaceFolderChildren(children, mountedUris).map(
        (child) => child.uri
      )
    ).toEqual(["local://folder/ordinary", "local://file/notebook"]);
  });

  it("does not hide a file whose URI is registered directly", () => {
    const children = [
      {
        uri: "local://file/notebook",
        type: NotebookStoreItemType.File,
      },
    ];

    expect(
      filterMountedWorkspaceFolderChildren(
        children,
        new Set(["local://file/notebook"])
      )
    ).toEqual(children);
  });
});
