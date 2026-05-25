import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { MimeType, RunmeMetadataKey, parser_pb } from "../../runme/client";
import { computeNotebookDiff } from "./diff";

const encoder = new TextEncoder();

function cell(args: {
  refId: string;
  value: string;
  kind?: parser_pb.CellKind;
  languageId?: string;
  metadata?: Record<string, string>;
  stdout?: string;
}) {
  return create(parser_pb.CellSchema, {
    refId: args.refId,
    kind: args.kind ?? parser_pb.CellKind.CODE,
    languageId: args.languageId ?? "python",
    value: args.value,
    metadata: args.metadata ?? {},
    outputs:
      args.stdout === undefined
        ? []
        : [
            create(parser_pb.CellOutputSchema, {
              items: [
                create(parser_pb.CellOutputItemSchema, {
                  mime: MimeType.VSCodeNotebookStdOut,
                  data: encoder.encode(args.stdout),
                }),
              ],
            }),
          ],
  });
}

function notebook(cells: parser_pb.Cell[]) {
  return create(parser_pb.NotebookSchema, {
    cells,
    metadata: {},
  });
}

describe("computeNotebookDiff", () => {
  it("matches cells by refId and reports source changes", () => {
    const diff = computeNotebookDiff(
      notebook([cell({ refId: "a", value: "x = 1\nprint(x)" })]),
      notebook([cell({ refId: "a", value: "x = 2\nprint(x)" })]),
    );

    expect(diff.summary.modifiedCells).toBe(1);
    expect(diff.summary.sourceChanges).toBe(1);
    expect(diff.cells[0].kind).toBe("modified");
    expect(diff.cells[0].sourceDiff?.changed).toBe(true);
  });

  it("reports inserted and deleted cells in compare order", () => {
    const diff = computeNotebookDiff(
      notebook([
        cell({ refId: "a", value: "base a" }),
        cell({ refId: "b", value: "base b" }),
      ]),
      notebook([
        cell({ refId: "a", value: "base a" }),
        cell({ refId: "c", value: "compare c" }),
      ]),
    );

    expect(diff.cells.map((row) => row.kind)).toEqual([
      "unchanged",
      "inserted",
      "deleted",
    ]);
    expect(diff.summary.insertedCells).toBe(1);
    expect(diff.summary.deletedCells).toBe(1);
  });

  it("ignores transient execution metadata but reports authored metadata", () => {
    const diff = computeNotebookDiff(
      notebook([
        cell({
          refId: "a",
          value: "print(1)",
          metadata: {
            [RunmeMetadataKey.Sequence]: "1",
            [RunmeMetadataKey.RunnerName]: "local",
          },
        }),
      ]),
      notebook([
        cell({
          refId: "a",
          value: "print(1)",
          metadata: {
            [RunmeMetadataKey.Sequence]: "2",
            [RunmeMetadataKey.RunnerName]: "remote",
          },
        }),
      ]),
    );

    expect(diff.summary.metadataChanges).toBe(1);
    expect(diff.cells[0].metadataDiff?.base).toEqual({
      [RunmeMetadataKey.RunnerName]: "local",
    });
    expect(diff.cells[0].metadataDiff?.compare).toEqual({
      [RunmeMetadataKey.RunnerName]: "remote",
    });
  });

  it("reports output-only changes as modified cells", () => {
    const diff = computeNotebookDiff(
      notebook([cell({ refId: "a", value: "print(value)", stdout: "old\n" })]),
      notebook([cell({ refId: "a", value: "print(value)", stdout: "new\n" })]),
    );

    expect(diff.summary.modifiedCells).toBe(1);
    expect(diff.summary.outputChanges).toBe(1);
    expect(diff.cells[0].changedFields).toContain("outputs");
  });
});

