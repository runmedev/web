import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { parser_pb } from "../../runme/client";
import { computeNotebookDiff } from "../../lib/notebookDiff/diff";
import { registerNotebookDiffDocument } from "../../lib/notebookDiff/registry";
import NotebookDiffView from "./NotebookDiffView";

function renderRoute(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/diff/:diffId" element={<NotebookDiffView />} />
      </Routes>
    </MemoryRouter>,
  );
}

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

describe("NotebookDiffView", () => {
  it("renders a registered side-by-side diff document", () => {
    const diff = computeNotebookDiff(
      notebook("print('base')"),
      notebook("print('compare')"),
    );
    const doc = registerNotebookDiffDocument({
      base: { label: "Drive revision 1", revisionId: "1" },
      compare: { label: "Local copy", revisionId: "local" },
      diff,
    });

    renderRoute(`/diff/${encodeURIComponent(doc.id)}`);

    expect(screen.getByText("Notebook Diff")).toBeTruthy();
    expect(screen.getByText(/Drive revision 1 compared with Local copy/)).toBeTruthy();
    expect(screen.getByText("Base: Drive revision 1")).toBeTruthy();
    expect(screen.getByText("Compare: Local copy")).toBeTruthy();
    expect(screen.getByText("print('base')")).toBeTruthy();
    expect(screen.getByText("print('compare')")).toBeTruthy();
  });

  it("renders unchanged cell contents inside the expandable row", () => {
    const diff = computeNotebookDiff(
      notebook("print('same')"),
      notebook("print('same')"),
    );
    const doc = registerNotebookDiffDocument({
      base: { label: "Drive revision 1", revisionId: "1" },
      compare: { label: "Local copy", revisionId: "local" },
      diff,
    });

    renderRoute(`/diff/${encodeURIComponent(doc.id)}`);

    expect(screen.getByText("Unchanged cell cell-1")).toBeTruthy();
    expect(screen.getAllByText("print('same')")).toHaveLength(2);
  });

  it("shows a recompute message for missing in-memory diff documents", () => {
    renderRoute("/diff/missing");

    expect(screen.getByText("Diff no longer available")).toBeTruthy();
  });
});
