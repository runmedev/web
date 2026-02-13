// @vitest-environment node

import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import { RunmeMetadataKey, parser_pb } from "../../contexts/CellContext";
import {
  createRunmeConsoleApi,
  type NotebookDataLike,
} from "./runmeConsole";

type FakeCellRunner = {
  run: () => void;
  getRunID: () => string;
  calls: number;
};

class FakeNotebookData implements NotebookDataLike {
  private readonly runners = new Map<string, FakeCellRunner>();
  updates: parser_pb.Cell[] = [];

  constructor(
    private readonly uri: string,
    private readonly name: string,
    private readonly notebook: parser_pb.Notebook,
    private readonly failedRunRefIds: Set<string> = new Set(),
    private readonly initialRunIds: Map<string, string> = new Map(),
  ) {
    for (const cell of notebook.cells ?? []) {
      if (!cell?.refId) {
        continue;
      }
      let runID = this.initialRunIds.get(cell.refId) ?? "";
      const runner: FakeCellRunner = {
        calls: 0,
        run: () => {
          runner.calls += 1;
          if (this.failedRunRefIds.has(cell.refId)) {
            return;
          }
          runID = `run-${cell.refId}-${runner.calls}`;
        },
        getRunID: () => runID,
      };
      this.runners.set(cell.refId, runner);
    }
  }

  getUri(): string {
    return this.uri;
  }

  getName(): string {
    return this.name;
  }

  getNotebook(): parser_pb.Notebook {
    return this.notebook;
  }

  updateCell(cell: parser_pb.Cell): void {
    this.updates.push(cell);
    this.notebook.cells = (this.notebook.cells ?? []).map((existing) => {
      if (existing.refId !== cell.refId) {
        return existing;
      }
      return create(parser_pb.CellSchema, cell);
    });
  }

  getCell(refId: string): FakeCellRunner | null {
    return this.runners.get(refId) ?? null;
  }
}

function codeCell(
  refId: string,
  value: string,
  opts: {
    outputs?: parser_pb.CellOutput[];
    metadata?: Record<string, string>;
  } = {},
): parser_pb.Cell {
  return create(parser_pb.CellSchema, {
    refId,
    kind: parser_pb.CellKind.CODE,
    languageId: "bash",
    value,
    outputs: opts.outputs ?? [],
    metadata: opts.metadata ?? {},
  });
}

describe("createRunmeConsoleApi", () => {
  it("returns the current notebook handle", () => {
    const notebook = create(parser_pb.NotebookSchema, { cells: [] });
    const model = new FakeNotebookData("local://one", "One", notebook);
    const resolveNotebook = vi.fn(() => model);
    const api = createRunmeConsoleApi({ resolveNotebook });

    expect(api.getCurrentNotebook()).toBe(model);
    expect(resolveNotebook).toHaveBeenCalledTimes(1);
  });

  it("clears outputs and run metadata for all matching cells", () => {
    const output = create(parser_pb.CellOutputSchema, {
      items: [
        create(parser_pb.CellOutputItemSchema, {
          mime: "text/plain",
          type: "Buffer",
          data: new TextEncoder().encode("hello"),
        }),
      ],
    });
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        codeCell("cell-a", "echo hi", {
          outputs: [output],
          metadata: {
            [RunmeMetadataKey.LastRunID]: "run-cell-a",
            [RunmeMetadataKey.Pid]: "42",
            [RunmeMetadataKey.ExitCode]: "0",
          },
        }),
        codeCell("cell-b", "echo bye"),
      ],
    });

    const model = new FakeNotebookData("local://one", "Notebook One", notebook);
    const api = createRunmeConsoleApi({
      resolveNotebook: () => model,
    });

    const message = api.clearOutputs();

    expect(message).toContain("Cleared 1 output item group(s) across 1 cell(s)");
    const updated = notebook.cells.find((cell) => cell.refId === "cell-a");
    expect(updated?.outputs).toHaveLength(0);
    expect(updated?.metadata?.[RunmeMetadataKey.LastRunID]).toBeUndefined();
    expect(updated?.metadata?.[RunmeMetadataKey.Pid]).toBeUndefined();
    expect(updated?.metadata?.[RunmeMetadataKey.ExitCode]).toBeUndefined();
    expect(model.updates).toHaveLength(1);
  });

  it("runs all non-empty code cells and reports start failures", () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        codeCell("cell-a", "echo a"),
        codeCell("cell-b", "   "),
        create(parser_pb.CellSchema, {
          refId: "cell-c",
          kind: parser_pb.CellKind.MARKUP,
          languageId: "markdown",
          value: "# title",
        }),
        codeCell("cell-d", "echo d"),
      ],
    });
    const model = new FakeNotebookData(
      "local://one",
      "Notebook One",
      notebook,
      new Set(["cell-d"]),
    );
    const api = createRunmeConsoleApi({
      resolveNotebook: () => model,
    });

    const message = api.runAll();

    expect(message).toContain("Started 1/2 code cell(s)");
    expect(message).toContain("1 failed to start");
    expect(model.getCell("cell-a")?.calls).toBe(1);
    expect(model.getCell("cell-b")?.calls).toBe(0);
    expect(model.getCell("cell-d")?.calls).toBe(1);
  });

  it("treats unchanged stale run IDs as failed starts", () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [codeCell("cell-a", "echo a")],
    });
    const model = new FakeNotebookData(
      "local://one",
      "Notebook One",
      notebook,
      new Set(["cell-a"]),
      new Map([["cell-a", "old-run-id"]]),
    );
    const api = createRunmeConsoleApi({
      resolveNotebook: () => model,
    });

    const message = api.runAll();

    expect(message).toContain("Started 0/1 code cell(s)");
    expect(message).toContain("1 failed to start");
  });

  it("documents notebook/URI helper usage in help text", () => {
    const notebook = create(parser_pb.NotebookSchema, { cells: [] });
    const model = new FakeNotebookData("local://one", "One", notebook);
    const api = createRunmeConsoleApi({
      resolveNotebook: () => model,
    });

    const message = api.help();

    expect(message).toContain("runme.clearOutputs([notebookOrUri])");
    expect(message).toContain("runme.runAll([notebookOrUri])");
  });
});
