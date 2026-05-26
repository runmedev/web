// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { NotebookStoreItemType } from "../storage/notebook";
import { NotebookSessionPersistence } from "./notebookSessionPersistence";

describe("NotebookSessionPersistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("restores current doc from sessionStorage", () => {
    const persistence = new NotebookSessionPersistence();
    window.sessionStorage.setItem("runme/currentDoc", "local://file/session");

    expect(persistence.loadCurrentDoc()).toBe("local://file/session");
  });

  it("writes only sessionStorage for current doc changes", () => {
    const persistence = new NotebookSessionPersistence();

    persistence.saveCurrentDoc("local://file/current");

    expect(window.sessionStorage.getItem("runme/currentDoc")).toBe(
      "local://file/current",
    );
  });

  it("restores empty current doc selections from sessionStorage", () => {
    const persistence = new NotebookSessionPersistence();

    persistence.saveCurrentDoc(null);

    expect(persistence.loadCurrentDoc()).toBeNull();
  });

  it("restores session open notebooks as OpenNotebookEntry records", () => {
    const persistence = new NotebookSessionPersistence();
    window.sessionStorage.setItem(
      "runme/openNotebooks",
      JSON.stringify([
        {
          uri: "local://file/legacy",
          name: "legacy.json",
          type: NotebookStoreItemType.File,
          children: [],
          parents: [],
        },
      ]),
    );

    expect(persistence.loadOpenNotebooks()).toEqual([
      {
        uri: "local://file/legacy",
        requestedUri: "local://file/legacy",
        name: "legacy.json",
        state: "loading",
        errorMessage: undefined,
        owner: undefined,
      },
    ]);
    expect(
      JSON.parse(window.sessionStorage.getItem("runme/openNotebooks") ?? "[]"),
    ).toEqual([
      expect.objectContaining({
        uri: "local://file/legacy",
        name: "legacy.json",
      }),
    ]);
  });

  it("restores empty open-notebook lists from sessionStorage", () => {
    const persistence = new NotebookSessionPersistence();
    window.sessionStorage.setItem("runme/openNotebooks", "[]");

    expect(persistence.loadOpenNotebooks()).toEqual([]);
  });
});
