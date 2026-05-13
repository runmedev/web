// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
    focusRequest = 0,
  }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    focusRequest?: number;
  }) => {
    const ref = React.useRef<HTMLTextAreaElement | null>(null);

    React.useEffect(() => {
      if (!focusRequest) {
        return;
      }
      ref.current?.focus();
    }, [focusRequest]);

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

describe("MarkdownCell", () => {
  it("restores focus into editor mode for markdown cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-focus-editor",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    const { rerender } = render(
      <MarkdownCell
        cellData={stub as unknown as CellData}
        selectedLanguage="markdown"
        languageSelectId="lang-md-focus-editor"
        languageOptions={[{ label: "Markdown", value: "markdown" }]}
        onLanguageChange={() => {}}
      />,
    );

    expect(screen.getByTestId("markdown-rendered")).toBeTruthy();

    await act(async () => {
      rerender(
        <MarkdownCell
          cellData={stub as unknown as CellData}
          selectedLanguage="markdown"
          languageSelectId="lang-md-focus-editor"
          languageOptions={[{ label: "Markdown", value: "markdown" }]}
          onLanguageChange={() => {}}
          restoreFocusRequest={1}
          restoreFocusRole="editor"
        />,
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId("markdown-editor")).toBeTruthy();
    expect(screen.getByTestId("mock-markdown-editor-input")).toHaveFocus();
  });

  it("restores focus onto rendered markdown when requested", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "md-focus-rendered",
      kind: parser_pb.CellKind.MARKUP,
      languageId: "markdown",
      outputs: [],
      metadata: {},
      value: "hello",
    });
    const stub = new StubCellData(cell);

    const { rerender } = render(
      <MarkdownCell
        cellData={stub as unknown as CellData}
        selectedLanguage="markdown"
        languageSelectId="lang-md-focus-rendered"
        languageOptions={[{ label: "Markdown", value: "markdown" }]}
        onLanguageChange={() => {}}
      />,
    );

    await act(async () => {
      rerender(
        <MarkdownCell
          cellData={stub as unknown as CellData}
          selectedLanguage="markdown"
          languageSelectId="lang-md-focus-rendered"
          languageOptions={[{ label: "Markdown", value: "markdown" }]}
          onLanguageChange={() => {}}
          restoreFocusRequest={1}
          restoreFocusRole="rendered"
        />,
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId("markdown-rendered")).toHaveFocus();
  });
});
