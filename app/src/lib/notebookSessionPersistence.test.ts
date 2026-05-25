// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { NotebookStoreItemType } from "../storage/notebook";
import { NotebookSessionPersistence } from "./notebookSessionPersistence";

describe("NotebookSessionPersistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("uses sessionStorage for current doc before legacy localStorage", () => {
    const persistence = new NotebookSessionPersistence();
    window.localStorage.setItem("runme/currentDoc", "local://file/legacy");
    window.sessionStorage.setItem("runme/currentDoc", "local://file/session");

    expect(persistence.loadCurrentDoc()).toBe("local://file/session");
  });

  it("imports legacy current doc into sessionStorage", () => {
    const persistence = new NotebookSessionPersistence();
    window.localStorage.setItem("runme/currentDoc", "local://file/legacy");

    expect(persistence.loadCurrentDoc()).toBe("local://file/legacy");
    expect(window.sessionStorage.getItem("runme/currentDoc")).toBe(
      "local://file/legacy",
    );
  });

  it("writes only sessionStorage for current doc changes", () => {
    const persistence = new NotebookSessionPersistence();

    persistence.saveCurrentDoc("local://file/current");

    expect(window.sessionStorage.getItem("runme/currentDoc")).toBe(
      "local://file/current",
    );
    expect(window.localStorage.getItem("runme/currentDoc")).toBeNull();
  });

  it("does not fall back to legacy current doc after the session clears selection", () => {
    const persistence = new NotebookSessionPersistence();
    window.localStorage.setItem("runme/currentDoc", "local://file/legacy");

    persistence.saveCurrentDoc(null);

    expect(persistence.loadCurrentDoc()).toBeNull();
  });

  it("imports legacy open notebooks as OpenNotebookEntry records", () => {
    const persistence = new NotebookSessionPersistence();
    window.localStorage.setItem(
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

  it("does not fall back to legacy open notebooks when session list is empty", () => {
    const persistence = new NotebookSessionPersistence();
    window.localStorage.setItem(
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
    window.sessionStorage.setItem("runme/openNotebooks", "[]");

    expect(persistence.loadOpenNotebooks()).toEqual([]);
  });
});
