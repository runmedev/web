// @vitest-environment node

import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import { RunmeMetadataKey, parser_pb } from "../../contexts/CellContext";
import {
  createNotebooksApi,
  createRunmeConsoleApi,
  type NotebookDataLike,
} from "./runmeConsole";

type FakeCellRunner = {
  run: () => void | Promise<void>;
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

  appendCodeCell(languageId?: string | null): parser_pb.Cell {
    const cell = create(parser_pb.CellSchema, {
      refId: `cell-${Math.random().toString(36).slice(2, 8)}`,
      kind: parser_pb.CellKind.CODE,
      languageId: languageId ?? "javascript",
      value: "",
      outputs: [],
      metadata: {},
    });
    this.notebook.cells = [...(this.notebook.cells ?? []), cell];
    return cell;
  }

  addCodeCellAfter(
    targetRefId: string,
    languageId?: string | null,
  ): parser_pb.Cell | null {
    const cells = this.notebook.cells ?? [];
    const index = cells.findIndex((cell) => cell.refId === targetRefId);
    if (index < 0) {
      return null;
    }
    const cell = create(parser_pb.CellSchema, {
      refId: `cell-${Math.random().toString(36).slice(2, 8)}`,
      kind: parser_pb.CellKind.CODE,
      languageId: languageId ?? "javascript",
      value: "",
      outputs: [],
      metadata: {},
    });
    const next = [...cells];
    next.splice(index + 1, 0, cell);
    this.notebook.cells = next;
    return cell;
  }

  addCodeCellBefore(
    targetRefId: string,
    languageId?: string | null,
  ): parser_pb.Cell | null {
    const cells = this.notebook.cells ?? [];
    const index = cells.findIndex((cell) => cell.refId === targetRefId);
    if (index < 0) {
      return null;
    }
    const cell = create(parser_pb.CellSchema, {
      refId: `cell-${Math.random().toString(36).slice(2, 8)}`,
      kind: parser_pb.CellKind.CODE,
      languageId: languageId ?? "javascript",
      value: "",
      outputs: [],
      metadata: {},
    });
    const next = [...cells];
    next.splice(index, 0, cell);
    this.notebook.cells = next;
    return cell;
  }

  removeCell(refId: string): void {
    this.notebook.cells = (this.notebook.cells ?? []).filter(
      (cell) => cell.refId !== refId,
    );
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

  it("supports clear alias", () => {
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
      cells: [codeCell("cell-a", "echo a", { outputs: [output] })],
    });
    const model = new FakeNotebookData("local://one", "Notebook One", notebook);
    const api = createRunmeConsoleApi({
      resolveNotebook: () => model,
    });

    const clearMessage = api.clear();
    const runMessage = api.runAll();

    expect(clearMessage).toContain("Cleared 1 output item group(s) across 1 cell(s)");
    expect(runMessage).toContain("Started 1/1 code cell(s)");
    expect(model.getCell("cell-a")?.calls).toBe(1);
  });

  it("reruns notebook by clearing outputs before running cells", () => {
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
        codeCell("cell-a", "echo a", {
          outputs: [output],
          metadata: {
            [RunmeMetadataKey.LastRunID]: "run-cell-a",
          },
        }),
      ],
    });
    const model = new FakeNotebookData("local://one", "Notebook One", notebook);
    const api = createRunmeConsoleApi({
      resolveNotebook: () => model,
    });

    const message = api.rerun();

    expect(message).toContain("Cleared 1 output item group(s) across 1 cell(s)");
    expect(message).toContain("Started 1/1 code cell(s)");
    expect(notebook.cells[0]?.outputs).toHaveLength(0);
    expect(model.getCell("cell-a")?.calls).toBe(1);
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

    expect(message).toContain("runme.clear()");
    expect(message).toContain("runme.runAll()");
    expect(message).toContain("runme.rerun()");
    expect(message).toContain("runme.clear(target)");
    expect(message).toContain("runme.runAll(target)");
    expect(message).toContain("runme.rerun(target)");
  });
});

describe("createNotebooksApi", () => {
  it("gets current notebook and returns handle + document", async () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [codeCell("cell-a", "echo a")],
    });
    const model = new FakeNotebookData("local://one", "One", notebook);
    const api = createNotebooksApi({
      resolveNotebook: () => model,
      listNotebooks: () => [model],
    });

    const document = await api.get();

    expect(document.summary.uri).toBe("local://one");
    expect(document.summary.name).toBe("One");
    expect(document.handle.uri).toBe("local://one");
    expect(document.handle.revision.length).toBeGreaterThan(0);
    expect(document.notebook.cells[0]?.refId).toBe("cell-a");
  });

  it("lists notebooks with query filters", async () => {
    const a = new FakeNotebookData(
      "local://one",
      "Notebook One",
      create(parser_pb.NotebookSchema, { cells: [] }),
    );
    const b = new FakeNotebookData(
      "local://two",
      "Notebook Two",
      create(parser_pb.NotebookSchema, { cells: [] }),
    );
    const api = createNotebooksApi({
      resolveNotebook: () => a,
      listNotebooks: () => [a, b],
    });

    const listed = await api.list({ nameContains: "two" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.uri).toBe("local://two");
  });

  it("applies insert/update/remove mutations", async () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [codeCell("cell-a", "echo a"), codeCell("cell-b", "echo b")],
    });
    const model = new FakeNotebookData("local://one", "One", notebook);
    const api = createNotebooksApi({
      resolveNotebook: () => model,
      listNotebooks: () => [model],
    });

    const updated = await api.update({
      operations: [
        {
          op: "insert",
          at: { afterRefId: "cell-a" },
          cells: [{ kind: "code", languageId: "javascript", value: "console.log('x')" }],
        },
      ],
    });
    expect(updated.notebook.cells.length).toBe(3);

    const insertedRefId =
      updated.notebook.cells.find((cell) => cell.refId !== "cell-a" && cell.refId !== "cell-b")
        ?.refId ?? "";

    const afterPatch = await api.update({
      operations: [
        {
          op: "update",
          refId: insertedRefId,
          patch: { value: "console.log('updated')" },
        },
      ],
    });
    const inserted = afterPatch.notebook.cells.find((cell) => cell.refId === insertedRefId);
    expect(inserted?.value).toContain("updated");

    const afterRemove = await api.update({
      operations: [{ op: "remove", refIds: [insertedRefId] }],
    });
    expect(afterRemove.notebook.cells.find((cell) => cell.refId === insertedRefId)).toBeUndefined();
  });

  it("awaits asynchronous cell execution in notebooks.execute", async () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [codeCell("cell-a", "echo a")],
    });
    const model = new FakeNotebookData("local://one", "One", notebook);
    const runner = model.getCell("cell-a");
    if (!runner) {
      throw new Error("expected runner for cell-a");
    }

    let completed = false;
    runner.run = async () => {
      runner.calls += 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      completed = true;
    };

    const api = createNotebooksApi({
      resolveNotebook: () => model,
      listNotebooks: () => [model],
    });

    await api.execute({ refIds: ["cell-a"] });

    expect(completed).toBe(true);
    expect(runner.calls).toBe(1);
  });
});
