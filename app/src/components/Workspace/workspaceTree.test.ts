import { describe, expect, it } from "vitest";

import {
  type WorkspaceFolderCandidate,
  filterNestedWorkspaceFolders,
} from "./workspaceTree";

function candidate(
  uri: string,
  parentUris: string[] = [],
): WorkspaceFolderCandidate {
  return {
    uri,
    name: uri,
    parentUris,
  };
}

describe("filterNestedWorkspaceFolders", () => {
  it("keeps only the mounted ancestor when nested folders are also mounted", async () => {
    const folders = [
      candidate("local://folder/root"),
      candidate("local://folder/root/child", ["local://folder/root"]),
      candidate("local://folder/root/child/grandchild", [
        "local://folder/root/child",
      ]),
      candidate("local://folder/other"),
    ];

    const visible = await filterNestedWorkspaceFolders(folders, async () => []);

    expect(visible.map((folder) => folder.uri)).toEqual([
      "local://folder/root",
      "local://folder/other",
    ]);
  });

  it("walks parent metadata to find non-immediate mounted ancestors", async () => {
    const folders = [
      candidate("local://folder/root"),
      candidate("local://folder/root/child/grandchild", [
        "local://folder/root/child",
      ]),
    ];
    const parents = new Map([
      ["local://folder/root/child", ["local://folder/root"]],
    ]);

    const visible = await filterNestedWorkspaceFolders(
      folders,
      async (uri) => parents.get(uri) ?? [],
    );

    expect(visible.map((folder) => folder.uri)).toEqual(["local://folder/root"]);
  });

  it("does not hide a workspace root that reports itself as its parent", async () => {
    const folders = [
      candidate("fs://workspace/demo/dir/", ["fs://workspace/demo/dir/"]),
    ];

    const visible = await filterNestedWorkspaceFolders(folders, async () => []);

    expect(visible.map((folder) => folder.uri)).toEqual([
      "fs://workspace/demo/dir/",
    ]);
  });
});
