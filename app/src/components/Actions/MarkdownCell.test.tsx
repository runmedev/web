// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { clone, create } from "@bufbuild/protobuf";
import React from "react";

import { parser_pb } from "../../runme/client";
import type { CellData } from "../../lib/notebookData";
import MarkdownCell from "./MarkdownCell";

vi.mock("./Editor", () => ({
  default: ({
    id,
    value,
    onChange,
    shouldFocus = false,
  }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    shouldFocus?: boolean;
  }) => {
    const ref = React.useRef<HTMLTextAreaElement | null>(null);
    const previousShouldFocusRef = React.useRef(false);

    React.useEffect(() => {
      const wasFocused = previousShouldFocusRef.current;
      previousShouldFocusRef.current = shouldFocus;
      if (!shouldFocus || wasFocused) {
        return;
      }
      ref.current?.focus();
    }, [shouldFocus]);

    return (
      <textarea
        ref={ref}
        data-testid="mock-markdown-editor-input"
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

class StubCellData {
  snapshot: parser_pb.Cell;
  private listeners = new Set<() => void>();

  constructor(cell: parser_pb.Cell) {
    this.snapshot = cell;
  }

  subscribeToContentChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(nextCell: parser_pb.Cell) {
    this.snapshot = clone(parser_pb.CellSchema, nextCell);
    this.listeners.forEach((listener) => listener());
  }
}

function renderMarkdownCell(
  cellData: CellData,
  props?: Partial<React.ComponentProps<typeof MarkdownCell>>,
) {
  return render(
    <MarkdownCell
      cellData={cellData}
      selectedLanguage="markdown"
      languageSelectId="lang-md-focus"
      languageOptions={[{ label: "Markdown", value: "markdown" }]}
      onLanguageChange={() => {}}
      {...props}
    />,
  );
}

describe("MarkdownCell", () => {
  it("starts markdown cells in editor mode when persisted focus target is editor", () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-active-editor",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    renderMarkdownCell(stub as unknown as CellData, {
      isActiveCell: true,
      activeFocusRole: "editor",
    });

    expect(screen.getByTestId("markdown-editor")).toBeTruthy();
    expect(screen.queryByTestId("markdown-rendered")).toBeNull();
  });

  it("focuses the editor when the window regains focus", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-focus-editor",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    const { rerender } = renderMarkdownCell(stub as unknown as CellData, {
      isActiveCell: true,
      activeFocusRole: "editor",
      isWindowFocused: false,
    });

    await act(async () => {
      rerender(
        <MarkdownCell
          cellData={stub as unknown as CellData}
          selectedLanguage="markdown"
          languageSelectId="lang-md-focus-editor"
          languageOptions={[{ label: "Markdown", value: "markdown" }]}
          onLanguageChange={() => {}}
          isActiveCell
          activeFocusRole="editor"
          isWindowFocused
        />,
      );
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(
      screen.getByTestId("mock-markdown-editor-input"),
    );
  });

  it("does not replay restore behavior on each editor change", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-typing",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    renderMarkdownCell(stub as unknown as CellData, {
      isActiveCell: true,
      activeFocusRole: "editor",
      isWindowFocused: true,
    });

    const input = screen.getByTestId("mock-markdown-editor-input");
    fireEvent.change(input, { target: { value: "hello world" } });

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("markdown-editor")).toBeTruthy();
    expect(screen.queryByTestId("markdown-rendered")).toBeNull();
  });

  it("focuses the editor when rendered markdown is opened for editing", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-manual-edit",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    renderMarkdownCell(stub as unknown as CellData);

    fireEvent.doubleClick(screen.getByTestId("markdown-rendered"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(
      screen.getByTestId("mock-markdown-editor-input"),
    );
  });

  it("focuses rendered markdown when leaving editor mode with escape", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-escape-rendered",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    renderMarkdownCell(stub as unknown as CellData, {
      isActiveCell: true,
      activeFocusRole: "editor",
      isWindowFocused: true,
    });

    fireEvent.keyDown(screen.getByTestId("markdown-editor"), {
      key: "Escape",
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(
      screen.getByTestId("markdown-rendered"),
    );
  });

  it("focuses rendered markdown when the window regains focus", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-focus-rendered",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    const { rerender } = renderMarkdownCell(stub as unknown as CellData, {
      isActiveCell: true,
      activeFocusRole: "rendered",
      isWindowFocused: false,
    });

    await act(async () => {
      rerender(
        <MarkdownCell
          cellData={stub as unknown as CellData}
          selectedLanguage="markdown"
          languageSelectId="lang-md-focus-rendered"
          languageOptions={[{ label: "Markdown", value: "markdown" }]}
          onLanguageChange={() => {}}
          isActiveCell
          activeFocusRole="rendered"
          isWindowFocused
        />,
      );
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(
      screen.getByTestId("markdown-rendered"),
    );
  });
});
