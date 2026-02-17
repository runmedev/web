// @vitest-environment jsdom
import { act } from "react";
import ReactDOM from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

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

  constructor(cell: parser_pb.Cell) {
    this.snapshot = cell;
  }

  subscribe(_listener: () => void): () => void {
    return () => {};
  }

  getStreams() {
    return undefined;
  }

  getRunID() {
    const runID = this.snapshot.metadata?.[RunmeMetadataKey.LastRunID];
    return typeof runID === "string" ? runID : "";
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
