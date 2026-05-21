// @vitest-environment jsdom
import { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

// Mock runmedev/renderers to avoid registering the real web component,
// which depends on adoptedStyleSheets and other browser-only APIs.
vi.mock("@runmedev/renderers", () => ({
  ClientMessages: {
    terminalStdin: "terminal:stdin",
    terminalStdout: "terminal:stdout",
  },
  setContext: vi.fn(),
}));

import { parser_pb, MimeType, RunmeMetadataKey } from "../../contexts/CellContext";
import { create } from "@bufbuild/protobuf";
import CellConsole from "./CellConsole";

class FakeCellData {
  snapshot: parser_pb.Cell;
  private readonly stream: any;

  constructor(cell: parser_pb.Cell, stream?: any) {
    this.snapshot = cell;
    this.stream = stream;
  }

  subscribe(_listener: () => void): () => void {
    return () => {};
  }

  getStreams() {
    return this.stream;
  }

  getRunID() {
    const runID = this.snapshot.metadata?.[RunmeMetadataKey.LastRunID];
    return typeof runID === "string" ? runID : "";
  }
}

function createSubject<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return {
        unsubscribe: () => listeners.delete(listener),
      };
    },
    emit(value: T) {
      listeners.forEach((listener) => listener(value));
    },
  };
}

function createFakeStream() {
  return {
    stdout: createSubject<Uint8Array>(),
    stderr: createSubject<Uint8Array>(),
    pid: createSubject<number>(),
    exitCode: createSubject<number>(),
    sendExecuteRequest: vi.fn(),
    setCallback: vi.fn(),
  };
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
  const roots: Array<ReactDOM.Root> = [];

  function renderConsole(cellData: FakeCellData) {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = ReactDOM.createRoot(div);
    roots.push(root);
    act(() => {
      root.render(
        <CellConsole cellData={cellData as any} onExitCode={() => {}} onPid={() => {}} />,
      );
    });
    return div;
  }

  afterEach(() => {
    act(() => {
      while (roots.length > 0) {
        roots.pop()?.unmount();
      }
    });
    document.body.innerHTML = "";
  });

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

    const div = renderConsole(cellData);

    await act(async () => {
      await Promise.resolve();
    });

    const consoleEl = div.querySelector("console-view") as FakeConsoleView | null;
    expect(consoleEl).not.toBeNull();
    const spans = consoleEl?.querySelectorAll(".xterm-rows span") ?? [];
    const texts = Array.from(spans).map((s) => s.textContent);
    expect(texts.join("")).toContain("hello world");
  });

  it("shows a stdin composer for active streams and sends a newline-terminated write", async () => {
    const stream = createFakeStream();
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-stdin",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.LastRunID]: "run-stdin",
      },
    });

    await act(async () => {
      renderConsole(new FakeCellData(cell, stream));
      await Promise.resolve();
    });

    const input = screen.getByTestId("cell-stdin-input") as HTMLInputElement;
    const submit = screen.getByTestId("cell-stdin-submit") as HTMLButtonElement;
    expect(screen.getByText("Provide input")).toBeTruthy();
    expect(screen.queryByTestId("cell-stdin-help")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Explain standard input"));
    });
    expect(
      screen.getByText(/Send one line of standard input to the running process/),
    ).toBeTruthy();
    expect(submit.disabled).toBe(true);

    await act(async () => {
      fireEvent.change(input, { target: { value: "y" } });
    });

    expect(submit.disabled).toBe(false);

    await act(async () => {
      fireEvent.submit(screen.getByTestId("cell-stdin-form"));
    });

    expect(stream.sendExecuteRequest).toHaveBeenCalledTimes(1);
    const request = stream.sendExecuteRequest.mock.calls[0][0] as {
      inputData?: Uint8Array;
    };
    expect(new TextDecoder().decode(request.inputData)).toBe("y\n");
    expect(input.value).toBe("");
  });

  it("renders partial stdout chunks immediately while the process is still running", async () => {
    const stream = createFakeStream();
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-live-prompt",
      kind: parser_pb.CellKind.CODE,
      languageId: "bash",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.LastRunID]: "run-live",
      },
    });

    let div: HTMLDivElement;
    await act(async () => {
      div = renderConsole(new FakeCellData(cell, stream));
      await Promise.resolve();
    });

    await act(async () => {
      stream.stdout.emit(new TextEncoder().encode("Password:"));
      await Promise.resolve();
    });

    const consoleEl = div!.querySelector("console-view") as FakeConsoleView | null;
    const spans = consoleEl?.querySelectorAll(".xterm-rows span") ?? [];
    const texts = Array.from(spans).map((s) => s.textContent).join("");
    expect(texts).toContain("Password:");
  });
});
