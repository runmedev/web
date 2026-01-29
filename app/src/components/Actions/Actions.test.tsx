// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
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
  private runListeners = new Set<(id: string) => void>();
  getRunnerName = () => "<default>";

  constructor(cell: parser_pb.Cell) {
    this.snapshot = cell;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeToRunIDChange(listener: (id: string) => void) {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  getRunID() {
    return this.runID;
  }

  setRunID(id: string) {
    this.runID = id;
    this.snapshot.metadata ??= {};
    // @ts-expect-error protobuf metadata map
    this.snapshot.metadata[parser_pb.RunmeMetadataKey] = id;
    this.listeners.forEach((l) => l());
    this.runListeners.forEach((l) => l(id));
  }

  getStreams() {
    return null;
  }
  addBefore() {}
  addAfter() {}
  update() {}
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
});
