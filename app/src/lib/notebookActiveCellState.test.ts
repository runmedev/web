// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  createNotebookActiveCellState,
  loadNotebookActiveCellMap,
  persistNotebookActiveCellMap,
} from "./notebookActiveCellState";

const STORAGE_KEY = "runme/notebook-active-cells";

describe("notebookActiveCellState", () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it("normalizes persisted notebook active-cell state", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        " local://file/demo.json ": {
          refId: " cell-a ",
          focusRole: "rendered",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
        "": {
          refId: "ignored",
          focusRole: "editor",
          updatedAt: "",
        },
        "local://file/bad.json": {
          refId: "",
          focusRole: "rendered",
          updatedAt: "",
        },
      }),
    );

    expect(loadNotebookActiveCellMap()).toEqual({
      "local://file/demo.json": {
        refId: "cell-a",
        focusRole: "rendered",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
    });
  });

  it("persists only valid entries", () => {
    persistNotebookActiveCellMap({
      " local://file/demo.json ": {
        refId: " cell-a ",
        focusRole: "editor",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
      "": {
        refId: "",
        focusRole: "rendered",
        updatedAt: "",
      },
    });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      "local://file/demo.json": {
        refId: "cell-a",
        focusRole: "editor",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
    });
  });

  it("creates timestamped active-cell entries", () => {
    const snapshot = createNotebookActiveCellState("cell-a", "rendered");
    expect(snapshot?.refId).toBe("cell-a");
    expect(snapshot?.focusRole).toBe("rendered");
    expect(snapshot?.updatedAt).toMatch(/^20\d\d-/);
  });
});
