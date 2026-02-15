import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { MimeType, parser_pb } from "../../runme/client";
import { hasVisibleCellOutput } from "./outputVisibility";

describe("hasVisibleCellOutput", () => {
  it("returns false for empty output arrays", () => {
    expect(hasVisibleCellOutput([])).toBe(false);
  });

  it("returns false for empty terminal placeholder items", () => {
    const outputs = [
      create(parser_pb.CellOutputSchema, {
        items: [
          create(parser_pb.CellOutputItemSchema, {
            mime: MimeType.StatefulRunmeTerminal,
            type: "Buffer",
            data: new Uint8Array(),
          }),
        ],
      }),
    ];

    expect(hasVisibleCellOutput(outputs)).toBe(false);
  });

  it("returns true when stdout has bytes", () => {
    const outputs = [
      create(parser_pb.CellOutputSchema, {
        items: [
          create(parser_pb.CellOutputItemSchema, {
            mime: MimeType.VSCodeNotebookStdOut,
            type: "Buffer",
            data: new TextEncoder().encode("hello"),
          }),
        ],
      }),
    ];

    expect(hasVisibleCellOutput(outputs)).toBe(true);
  });
});
