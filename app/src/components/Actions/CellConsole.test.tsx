// @vitest-environment jsdom
import { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock runmedev/renderers to avoid registering the real web component,
// which depends on adoptedStyleSheets and other browser-only APIs.
vi.mock("@runmedev/renderers", () => ({
  ClientMessages: {
    terminalStdin: "terminal:stdin",
    terminalStdout: "terminal:stdout",
  },
  setContext: vi.fn(),
}));

import { parser_pb, MimeType } from "../../contexts/CellContext";
import { create } from "@bufbuild/protobuf";
import CellConsole from "./CellConsole";

// Fake streams for controlling stdout/pid/exitCode in tests.
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

class FakeCellData {
  snapshot: parser_pb.Cell;
  fakeStreams: FakeStreams | null = null;

  constructor(cell: parser_pb.Cell) {
    this.snapshot = cell;
  }

  subscribe(_listener: () => void): () => void {
    return () => {};
  }

  getStreams() {
    return this.fakeStreams;
  }

  getRunID() {
    return "run-test";
  }
}

// Minimal console-view stub so the component can construct it.
class FakeConsoleView extends HTMLElement {
  initialContent = "";
  context: any;
  rowsContainer: HTMLDivElement | null = null;
  terminal = {
    write: (data: any) => {
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      const span = document.createElement("span");
      span.textContent = text;
      this.rowsContainer?.appendChild(span);
    },
  };
  updateComplete = Promise.resolve();

  connectedCallback() {
    this.rowsContainer = document.createElement("div");
    this.rowsContainer.className = "xterm-rows";
    this.appendChild(this.rowsContainer);
  }
}

describe("CellConsole", () => {
  it("renders existing stdout content from cell outputs", async () => {
    if (!customElements.get("console-view")) {
      customElements.define("console-view", FakeConsoleView);
    }

    const terminalOutput = create(parser_pb.CellOutputSchema, {
      items: [
        create(parser_pb.CellOutputItemSchema, {
          mime: MimeType.StatefulRunmeTerminal,
          type: "Buffer",
          data: new Uint8Array(),
        }),
      ],
    });

    const stdoutOutput = create(parser_pb.CellOutputSchema, {
      items: [
        create(parser_pb.CellOutputItemSchema, {
          mime: MimeType.VSCodeNotebookStdOut,
          type: "Buffer",
          data: new TextEncoder().encode("hello world"),
        }),
      ],
    });

    const cell = create(parser_pb.CellSchema, {
      refId: "cell-stdout",
      kind: parser_pb.CellKind.CODE,
      outputs: [terminalOutput, stdoutOutput],
      metadata: {},
    });

    const cellData = new FakeCellData(cell);
    const div = document.createElement("div");
    document.body.appendChild(div);

    await act(async () => {
      const root = ReactDOM.createRoot(div);
      root.render(
        <CellConsole cellData={cellData as any} onExitCode={() => {}} onPid={() => {}} />,
      );
      // Let effects flush
      await Promise.resolve();
    });

    const consoleEl = div.querySelector("console-view") as FakeConsoleView | null;
    expect(consoleEl).not.toBeNull();
    const spans = consoleEl?.querySelectorAll(".xterm-rows span") ?? [];
    const texts = Array.from(spans).map((s) => s.textContent);
    expect(texts.join("")).toContain("hello world");
  });
});

describe("CellConsole stdout flush", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function getTerminalText(container: HTMLElement): string {
    const consoleEl = container.querySelector("console-view") as FakeConsoleView | null;
    const spans = consoleEl?.querySelectorAll(".xterm-rows span") ?? [];
    return Array.from(spans).map((s) => s.textContent).join("");
  }

  async function renderWithStreams() {
    if (!customElements.get("console-view")) {
      customElements.define("console-view", FakeConsoleView);
    }

    const cell = create(parser_pb.CellSchema, {
      refId: "cell-flush",
      kind: parser_pb.CellKind.CODE,
      outputs: [],
      metadata: {},
    });

    const streams = new FakeStreams();
    const cellData = new FakeCellData(cell);
    cellData.fakeStreams = streams;

    const div = document.createElement("div");
    document.body.appendChild(div);

    await act(async () => {
      const root = ReactDOM.createRoot(div);
      root.render(
        <CellConsole cellData={cellData as any} onExitCode={() => {}} onPid={() => {}} />,
      );
      await Promise.resolve();
    });

    return { streams, div };
  }

  it("flushes partial stdout line after timeout", async () => {
    vi.useFakeTimers();
    const { streams, div } = await renderWithStreams();

    // Emit partial line (no newline)
    await act(async () => {
      streams.emitStdout(new TextEncoder().encode("Password:"));
    });

    // Before timer fires, partial line should still be buffered
    expect(getTerminalText(div)).not.toContain("Password:");

    // Advance timer past 150ms flush threshold
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(getTerminalText(div)).toContain("Password:");
    document.body.removeChild(div);
  });

  it("does not double-write when newline arrives after flush", async () => {
    vi.useFakeTimers();
    const { streams, div } = await renderWithStreams();

    // Emit partial line
    await act(async () => {
      streams.emitStdout(new TextEncoder().encode("Password:"));
    });

    // Flush via timer
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // Now send the trailing newline
    await act(async () => {
      streams.emitStdout(new TextEncoder().encode("\n"));
    });

    // "Password:" should appear exactly once
    const text = getTerminalText(div);
    expect(text.match(/Password:/g)?.length).toBe(1);
    document.body.removeChild(div);
  });

  it("complete lines are written immediately", async () => {
    const { streams, div } = await renderWithStreams();

    // Emit complete lines
    await act(async () => {
      streams.emitStdout(new TextEncoder().encode("hello\nworld\n"));
    });

    // Both lines should appear immediately without needing a timer
    const text = getTerminalText(div);
    expect(text).toContain("hello");
    expect(text).toContain("world");
    document.body.removeChild(div);
  });
});
