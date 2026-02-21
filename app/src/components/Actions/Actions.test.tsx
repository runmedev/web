// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { clone, create } from "@bufbuild/protobuf";
import React from "react";

import { parser_pb, RunmeMetadataKey } from "../../runme/client";
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

// Fake streams for testing PID/exitCode callbacks through CellConsole subscriptions.
class FakeStreams {
  private pidCbs = new Set<(pid: number) => void>();
  private exitCbs = new Set<(code: number) => void>();
  private stdoutCbs = new Set<(data: Uint8Array) => void>();
  private stderrCbs = new Set<(data: Uint8Array) => void>();

  stdout = {
    subscribe: (cb: (data: Uint8Array) => void) => {
      this.stdoutCbs.add(cb);
      return { unsubscribe: () => this.stdoutCbs.delete(cb) };
    },
  };
  stderr = {
    subscribe: (cb: (data: Uint8Array) => void) => {
      this.stderrCbs.add(cb);
      return { unsubscribe: () => this.stderrCbs.delete(cb) };
    },
  };
  pid = {
    subscribe: (cb: (pid: number) => void) => {
      this.pidCbs.add(cb);
      return { unsubscribe: () => this.pidCbs.delete(cb) };
    },
  };
  exitCode = {
    subscribe: (cb: (code: number) => void) => {
      this.exitCbs.add(cb);
      return { unsubscribe: () => this.exitCbs.delete(cb) };
    },
  };

  emitPid(pid: number) { this.pidCbs.forEach((cb) => cb(pid)); }
  emitExitCode(code: number) { this.exitCbs.forEach((cb) => cb(code)); }
  emitStdout(data: Uint8Array) { this.stdoutCbs.forEach((cb) => cb(data)); }

  setCallback() {}
  sendExecuteRequest() {}
  close() {}
}

// Minimal stub CellData to drive runID changes.
class StubCellData {
  snapshot: parser_pb.Cell;
  private listeners = new Set<() => void>();
  getRunnerName = () => "<default>";
  update = vi.fn((nextCell: parser_pb.Cell) => {
    this.snapshot = clone(parser_pb.CellSchema, nextCell);
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
    const runID = this.snapshot.metadata?.[RunmeMetadataKey.LastRunID];
    return typeof runID === "string" ? runID : "";
  }

  setRunID(id: string) {
    const next = clone(parser_pb.CellSchema, this.snapshot);
    next.metadata = { ...(next.metadata ?? {}) };
    if (id) {
      next.metadata[RunmeMetadataKey.LastRunID] = id;
    } else {
      delete next.metadata[RunmeMetadataKey.LastRunID];
    }
    this.update(next);
  }

  fakeStreams: FakeStreams | null = null;

  getStreams() {
    return this.fakeStreams;
  }
  addBefore() {}
  addAfter() {}
  remove() {}
  run() {}
  setRunner() {}
}

describe("Action component", () => {
  it("updates CellConsole key when runID changes", async () => {
    const cell =  create(parser_pb.CellSchema,{
      refId: "cell-1",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.LastRunID]: "run-0",
      },
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
      metadata: {
        [RunmeMetadataKey.LastRunID]: "run-0",
      },
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

  it("shows idle bracket [ ] before first run", () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-idle",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hello",
    });
    const stub = new StubCellData(cell);

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);

    const bracket = screen.getByTestId("cell-bracket");
    expect(bracket.textContent).toBe("[ ]");
  });

  it("shows pending state immediately on run click", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-pend",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hello",
    });
    const stub = new StubCellData(cell);
    stub.fakeStreams = new FakeStreams();

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);

    const cellCard = document.getElementById("cell-card-cell-pend")!;
    expect(cellCard.getAttribute("data-exec-state")).toBe("idle");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Run code"));
    });

    expect(cellCard.getAttribute("data-exec-state")).toBe("pending");
    const bracket = screen.getByTestId("cell-bracket");
    expect(bracket.textContent).toBe("[*]");
  });

  it("transitions to running state on PID", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-run",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hello",
    });
    const stub = new StubCellData(cell);
    const streams = new FakeStreams();
    stub.fakeStreams = streams;

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);

    // Wait for CellConsole's useEffect to subscribe to streams
    await act(async () => { await Promise.resolve(); });

    // Click run to enter pending state
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Run code"));
    });

    const cellCard = document.getElementById("cell-card-cell-run")!;
    expect(cellCard.getAttribute("data-exec-state")).toBe("pending");

    // Emit PID to transition to running
    await act(async () => {
      streams.emitPid(42);
    });

    expect(cellCard.getAttribute("data-exec-state")).toBe("running");
  });

  it("transitions to success state on exitCode 0", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-ok",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hello",
    });
    cell.metadata[RunmeMetadataKey.Sequence] = "1";
    const stub = new StubCellData(cell);
    const streams = new FakeStreams();
    stub.fakeStreams = streams;

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);
    await act(async () => { await Promise.resolve(); });

    // Run → PID → exit 0
    await act(async () => { fireEvent.click(screen.getByLabelText("Run code")); });
    await act(async () => { streams.emitPid(42); });
    await act(async () => { streams.emitExitCode(0); });

    const cellCard = document.getElementById("cell-card-cell-ok")!;
    expect(cellCard.getAttribute("data-exec-state")).toBe("success");

    const bracket = screen.getByTestId("cell-bracket");
    expect(bracket.textContent).toBe("[1]");
  });

  it("transitions to error state on non-zero exitCode", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-err",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "exit 1",
    });
    const stub = new StubCellData(cell);
    const streams = new FakeStreams();
    stub.fakeStreams = streams;

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);
    await act(async () => { await Promise.resolve(); });

    await act(async () => { fireEvent.click(screen.getByLabelText("Run code")); });
    await act(async () => { streams.emitPid(42); });
    await act(async () => { streams.emitExitCode(1); });

    const cellCard = document.getElementById("cell-card-cell-err")!;
    expect(cellCard.getAttribute("data-exec-state")).toBe("error");

    const bracket = screen.getByTestId("cell-bracket");
    expect(bracket.textContent).toBe("[!]");
  });

  it("resets to pending on re-run after success", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-rerun",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {},
      value: "echo hello",
    });
    const stub = new StubCellData(cell);
    const streams = new FakeStreams();
    stub.fakeStreams = streams;

    render(<Action cellData={stub as unknown as CellData} isFirst={false} />);
    await act(async () => { await Promise.resolve(); });

    // First run → success
    await act(async () => { fireEvent.click(screen.getByLabelText("Run code")); });
    await act(async () => { streams.emitPid(42); });
    await act(async () => { streams.emitExitCode(0); });

    const cellCard = document.getElementById("cell-card-cell-rerun")!;
    expect(cellCard.getAttribute("data-exec-state")).toBe("success");

    // Re-run → should go back to pending
    await act(async () => { fireEvent.click(screen.getByLabelText("Run code")); });
    expect(cellCard.getAttribute("data-exec-state")).toBe("pending");
  });
});
