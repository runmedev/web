// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import React from "react";

import { parser_pb } from "../../runme/client";
import type { CellData } from "../../lib/notebookData";
import { Action } from "./Actions";

// Minimal mocks for contexts Action consumes
vi.mock("../../contexts/OutputContext", () => ({
  useOutput: () => ({
    getRenderer: () => undefined,
    getAllRenderers: () => new Map(),
    registerRenderer: () => {},
    unregisterRenderer: () => {},
  }),
}));

vi.mock("../../contexts/RunnersContext", () => ({
  useRunners: () => ({
    listRunners: () => [],
    defaultRunnerName: "<default>",
  }),
}));

vi.mock("../../contexts/SettingsContext", () => ({
  useSettings: () => ({
    createAuthInterceptors: () => [],
    webAppSettings: { runner: "", language: "" },
  }),
}));

vi.mock("../../contexts/NotebookContext", () => ({
  useNotebookContext: () => ({
    getNotebookData: () => null,
    useNotebookSnapshot: () => null,
    useNotebookList: () => [],
    removeNotebook: () => {},
  }),
}));

vi.mock("../../contexts/CurrentDocContext", () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => null,
    setCurrentDoc: () => {},
  }),
}));

// Mock runmedev/renderers to avoid registering the real web component,
// which depends on adoptedStyleSheets and other browser-only APIs.
vi.mock("@runmedev/renderers", () => ({
  ClientMessages: {
    terminalStdin: "terminal:stdin",
    terminalStdout: "terminal:stdout",
  },
  setContext: vi.fn(),
}));

vi.mock("../../contexts/CellContext", () => ({}));

// Minimal stub CellData to drive runID changes.
class StubCellData {
  snapshot: parser_pb.Cell;
  private runID = "run-0";
  private listeners = new Set<() => void>();
  getRunnerName = () => "<default>";
  update = vi.fn((nextCell: parser_pb.Cell) => {
    this.snapshot = create(parser_pb.CellSchema, nextCell);
    this.listeners.forEach((listener) => listener());
  });

  constructor(cell: parser_pb.Cell) {
    this.snapshot = cell;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeToContentChange(listener: () => void) {
    return this.subscribe(listener);
  }

  subscribeToRunIDChange(listener: (id: string) => void) {
    return () => {};
  }

  getRunID() {
    return this.runID;
  }

  setRunID(id: string) {
    this.runID = id;
    this.listeners.forEach((l) => l());
  }

  getStreams() {
    return null;
  }
  addBefore() {}
  addAfter() {}
  remove() {}
  run() {}
}

describe("Action component", () => {
  it("updates CellConsole key when runID changes", async () => {
    const cell =  create(parser_pb.CellSchema,{
      refId: "cell-1",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hi",
    });
    const stub = new StubCellData(cell) as unknown as CellData;

    render(<Action cellData={stub} isFirst={false} />);

    const first = screen.getByTestId("cell-console") as HTMLElement;
    const firstKey = first.dataset.runkey;

    await act(async () => {
      stub.setRunID("run-123");
      await Promise.resolve();
    });

    const second = screen.getByTestId("cell-console") as HTMLElement;
    const secondKey = second.dataset.runkey;

    expect(firstKey).not.toBe(secondKey);
  });

  it("hides console output area when runID is cleared and outputs are empty", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-clear",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hi",
    });
    const stub = new StubCellData(cell) as unknown as CellData;

    render(<Action cellData={stub} isFirst={false} />);
    expect(screen.getByTestId("cell-console")).toBeTruthy();

    await act(async () => {
      stub.setRunID("");
      await Promise.resolve();
    });

    expect(screen.queryByTestId("cell-console")).toBeNull();
  });

  it("shows language selector in markdown edit mode and converts to code language", () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-md",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "",
    });
    const stub = new StubCellData(cell);

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);

    const selector = screen.getByRole("combobox");
    expect(selector).toBeTruthy();
    expect((selector as HTMLSelectElement).value).toBe("markdown");

    fireEvent.change(selector, { target: { value: "bash" } });

    expect(stub.update).toHaveBeenCalledTimes(1);
    const updatedCell = stub.update.mock.calls[0][0] as parser_pb.Cell;
    expect(updatedCell.kind).toBe(parser_pb.CellKind.CODE);
    expect(updatedCell.languageId).toBe("bash");
  });

  it("converts code cell to markdown kind when switching to markdown", () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-code",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hi",
    });
    const stub = new StubCellData(cell);

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);

    const selector = document.getElementById("language-select-cell-code") as
      | HTMLSelectElement
      | null;
    expect(selector).toBeTruthy();
    fireEvent.change(selector, { target: { value: "markdown" } });

    expect(stub.update).toHaveBeenCalledTimes(1);
    const updatedCell = stub.update.mock.calls[0][0] as parser_pb.Cell;
    expect(updatedCell.kind).toBe(parser_pb.CellKind.MARKUP);
    expect(updatedCell.languageId).toBe("markdown");
  });
});
