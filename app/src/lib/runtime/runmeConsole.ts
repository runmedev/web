import { create } from "@bufbuild/protobuf";
import md5 from "md5";

import { RunmeMetadataKey, parser_pb } from "../../runme/client";

type CellRunnerLike = {
  run: () => void | Promise<void>;
  getRunID: () => string;
};

export type NotebookDataLike = {
  getUri: () => string;
  getName: () => string;
  getNotebook: () => parser_pb.Notebook;
  updateCell: (cell: parser_pb.Cell) => void;
  getCell: (refId: string) => CellRunnerLike | null;
  appendCodeCell?: (languageId?: string | null) => parser_pb.Cell;
  addCodeCellAfter?: (
    targetRefId: string,
    languageId?: string | null,
  ) => parser_pb.Cell | null;
  addCodeCellBefore?: (
    targetRefId: string,
    languageId?: string | null,
  ) => parser_pb.Cell | null;
  removeCell?: (refId: string) => void;
};

export type NotebookSummary = {
  uri: string;
  name: string;
  isOpen: boolean;
  source: "local" | "fs" | "drive";
};

export type NotebookQuery = {
  openOnly?: boolean;
  uriPrefix?: string;
  nameContains?: string;
  limit?: number;
};

export type NotebookHandle = {
  uri: string;
  revision: string;
};

export type NotebookTarget = { uri: string } | { handle: NotebookHandle };

export type NotebookDocument = {
  summary: NotebookSummary;
  handle: NotebookHandle;
  notebook: parser_pb.Notebook;
};

export type CellPatch = {
  value?: string;
  languageId?: string;
  metadata?: Record<string, string>;
  outputs?: parser_pb.CellOutput[];
};

export type CellLocation =
  | { index: number }
  | { beforeRefId: string }
  | { afterRefId: string };

export type InsertCellSpec = {
  kind: "code" | "markup";
  languageId?: string;
  value?: string;
  metadata?: Record<string, string>;
};

export type NotebookMutation =
  | {
      op: "insert";
      at: CellLocation;
      cells: InsertCellSpec[];
    }
  | {
      op: "update";
      refId: string;
      patch: CellPatch;
    }
  | {
      op: "remove";
      refIds: string[];
    };

export type NotebookMethod =
  | "list"
  | "get"
  | "update"
  | "delete"
  | "execute";

export type NotebooksApi = {
  help: (topic?: NotebookMethod) => Promise<string>;
  list: (query?: NotebookQuery) => Promise<NotebookSummary[]>;
  get: (target?: NotebookTarget) => Promise<NotebookDocument>;
  update: (args: {
    target?: NotebookTarget;
    expectedRevision?: string;
    operations: NotebookMutation[];
    reason?: string;
  }) => Promise<NotebookDocument>;
  delete: (target: NotebookTarget) => Promise<void>;
  execute: (args: {
    target?: NotebookTarget;
    refIds: string[];
  }) => Promise<{ handle: NotebookHandle; cells: parser_pb.Cell[] }>;
};

export type RunmeConsoleApi = {
  getCurrentNotebook: () => NotebookDataLike | null;
  clear: (target?: unknown) => string;
  clearOutputs: (target?: unknown) => string;
  runAll: (target?: unknown) => string;
  rerun: (target?: unknown) => string;
  help: () => string;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function inferNotebookSource(uri: string): NotebookSummary["source"] {
  const normalized = (uri ?? "").toLowerCase();
  if (normalized.startsWith("local://")) {
    return "local";
  }
  if (normalized.startsWith("fs://") || normalized.startsWith("file://")) {
    return "fs";
  }
  if (normalized.startsWith("https://drive.google.com/")) {
    return "drive";
  }
  return "local";
}

function createRevision(notebook: parser_pb.Notebook): string {
  // Deterministic content hash used for optimistic checks in runtime helpers.
  return md5(JSON.stringify(notebook));
}

function makeHandle(notebook: NotebookDataLike): NotebookHandle {
  return {
    uri: notebook.getUri(),
    revision: createRevision(notebook.getNotebook()),
  };
}

function makeDocument(notebook: NotebookDataLike): NotebookDocument {
  const handle = makeHandle(notebook);
  return {
    summary: {
      uri: notebook.getUri(),
      name: notebook.getName(),
      isOpen: true,
      source: inferNotebookSource(notebook.getUri()),
    },
    handle,
    notebook: notebook.getNotebook(),
  };
}

function resolveTargetUri(target?: NotebookTarget): string | null {
  if (target === undefined) {
    return null;
  }
  if (!target || typeof target !== "object") {
    throw new Error(
      `Invalid notebook target ${JSON.stringify(target)}. ` +
        `Use target: { uri: "local://..." } or target: { handle: { uri: "local://...", revision: "..." } }.`,
    );
  }
  if ("uri" in target && typeof target.uri === "string" && target.uri.trim() !== "") {
    return target.uri.trim();
  }
  if (
    "handle" in target &&
    target.handle &&
    typeof target.handle.uri === "string" &&
      target.handle.uri.trim() !== ""
  ) {
    return target.handle.uri.trim();
  }
  throw new Error(
    `Invalid notebook target ${JSON.stringify(target)}. ` +
      `Use target: { uri: "local://..." } or target: { handle: { uri: "local://...", revision: "..." } }.`,
  );
}

function formatMissingTargetError(method: "update" | "delete" | "execute"): string {
  if (method === "update") {
    return (
      "notebooks.update requires an explicit target notebook. " +
      "Pass target: { handle: doc.handle } after const doc = await notebooks.get(), " +
      'or target: { uri: "local://..." }.'
    );
  }
  if (method === "execute") {
    return (
      "notebooks.execute requires an explicit target notebook. " +
      "Pass target: { handle: doc.handle } after const doc = await notebooks.get(), " +
      'or target: { uri: "local://..." }.'
    );
  }
  return (
    "notebooks.delete requires an explicit target notebook. " +
    'Pass target: { uri: "local://..." } or target: { handle: { uri: "local://...", revision: "..." } }.'
  );
}

function resolveInsertIndex(
  notebook: NotebookDataLike,
  at: CellLocation,
): { beforeRefId?: string; afterRefId?: string; append?: true } {
  const cells = notebook.getNotebook().cells ?? [];
  if ("beforeRefId" in at) {
    return { beforeRefId: at.beforeRefId };
  }
  if ("afterRefId" in at) {
    return { afterRefId: at.afterRefId };
  }
  const rawIndex = at.index;
  if (!Number.isInteger(rawIndex)) {
    throw new Error(`Invalid insert index: ${String(rawIndex)}`);
  }
  if (cells.length === 0) {
    return { append: true };
  }
  let normalizedIndex = rawIndex;
  if (rawIndex < 0) {
    normalizedIndex = cells.length + rawIndex + 1;
  }
  if (normalizedIndex <= 0) {
    return { beforeRefId: cells[0]?.refId };
  }
  if (normalizedIndex >= cells.length) {
    return { append: true };
  }
  return { beforeRefId: cells[normalizedIndex]?.refId };
}

function applyInsertedCellSpec(
  notebook: NotebookDataLike,
  inserted: parser_pb.Cell,
  spec: InsertCellSpec,
): void {
  const updated = create(parser_pb.CellSchema, inserted);
  updated.kind =
    spec.kind === "markup" ? parser_pb.CellKind.MARKUP : parser_pb.CellKind.CODE;
  updated.languageId =
    spec.languageId ??
    (spec.kind === "markup" ? "markdown" : updated.languageId ?? "javascript");
  if (typeof spec.value === "string") {
    updated.value = spec.value;
  }
  if (spec.metadata) {
    updated.metadata = {
      ...(updated.metadata ?? {}),
      ...spec.metadata,
    };
  }
  notebook.updateCell(updated);
}

function insertCells(
  notebook: NotebookDataLike,
  at: CellLocation,
  specs: InsertCellSpec[],
): void {
  if (!Array.isArray(specs) || specs.length === 0) {
    return;
  }
  if (
    typeof notebook.appendCodeCell !== "function" ||
    typeof notebook.addCodeCellBefore !== "function" ||
    typeof notebook.addCodeCellAfter !== "function" ||
    typeof notebook.removeCell !== "function"
  ) {
    throw new Error("Notebook does not support insert operations.");
  }

  const location = resolveInsertIndex(notebook, at);
  const insertedRefIds: string[] = [];
  const rollbackInsertedCells = () => {
    for (let i = insertedRefIds.length - 1; i >= 0; i -= 1) {
      notebook.removeCell(insertedRefIds[i]);
    }
  };

  try {
    if (location.beforeRefId) {
      for (let i = specs.length - 1; i >= 0; i -= 1) {
        const inserted = notebook.addCodeCellBefore(
          location.beforeRefId,
          specs[i]?.languageId ?? "javascript",
        );
        if (!inserted) {
          throw new Error(`Failed to insert before cell: ${location.beforeRefId}`);
        }
        insertedRefIds.push(inserted.refId);
        applyInsertedCellSpec(notebook, inserted, specs[i]);
      }
      return;
    }

    if (location.afterRefId) {
      let anchor = location.afterRefId;
      for (const spec of specs) {
        const inserted = notebook.addCodeCellAfter(
          anchor,
          spec.languageId ?? "javascript",
        );
        if (!inserted) {
          throw new Error(`Failed to insert after cell: ${anchor}`);
        }
        insertedRefIds.push(inserted.refId);
        applyInsertedCellSpec(notebook, inserted, spec);
        anchor = inserted.refId;
      }
      return;
    }

    for (const spec of specs) {
      const inserted = notebook.appendCodeCell(spec.languageId ?? "javascript");
      insertedRefIds.push(inserted.refId);
      applyInsertedCellSpec(notebook, inserted, spec);
    }
  } catch (error) {
    rollbackInsertedCells();
    throw error;
  }
}

function updateCellPatch(
  notebook: NotebookDataLike,
  refId: string,
  patch: CellPatch,
): void {
  const existing = notebook.getNotebook().cells.find((cell) => cell.refId === refId);
  if (!existing) {
    throw new Error(`Cell not found: ${refId}`);
  }
  const updated = create(parser_pb.CellSchema, existing);
  if (typeof patch.value === "string") {
    updated.value = patch.value;
  }
  if (typeof patch.languageId === "string") {
    updated.languageId = patch.languageId;
  }
  if (patch.metadata) {
    updated.metadata = {
      ...(updated.metadata ?? {}),
      ...patch.metadata,
    };
  }
  if (Array.isArray(patch.outputs)) {
    updated.outputs = patch.outputs;
  }
  notebook.updateCell(updated);
}

function formatNotebookMutationError(index: number, operation: unknown): string {
  const op =
    operation && typeof operation === "object" && "op" in operation
      ? JSON.stringify((operation as { op?: unknown }).op)
      : JSON.stringify(operation);
  return (
    `Unsupported notebooks.update operation at operations[${index}]: ${op}. ` +
    `Supported ops are "insert", "update", and "remove". ` +
    `To append a cell, use ` +
    `operations: [{ op: "insert", at: { index: -1 }, cells: [{ kind: "code", languageId: "python", value: "print(\\"hello\\")" }] }].`
  );
}

export function createNotebooksApi({
  resolveNotebook,
  listNotebooks,
}: {
  resolveNotebook: (target?: unknown) => NotebookDataLike | null;
  listNotebooks?: () => NotebookDataLike[];
}): NotebooksApi {
  const resolveNotebookByTarget = (target?: NotebookTarget): NotebookDataLike => {
    const uri = resolveTargetUri(target);
    const resolved = uri ? resolveNotebook(uri) : resolveNotebook();
    if (!resolved) {
      throw new Error("No notebook found for the requested target.");
    }
    return resolved;
  };

  const resolveNotebookByRequiredTarget = (
    method: "update" | "delete" | "execute",
    target?: NotebookTarget,
  ): NotebookDataLike => {
    if (target === undefined) {
      throw new Error(formatMissingTargetError(method));
    }
    return resolveNotebookByTarget(target);
  };

  const listKnownNotebooks = (): NotebookDataLike[] => {
    const listed = listNotebooks?.() ?? [];
    if (listed.length > 0) {
      return listed;
    }
    const current = resolveNotebook();
    return current ? [current] : [];
  };

  const help = async (topic?: NotebookMethod) => {
    if (topic === "list") {
      return "notebooks.list(query?: { openOnly?: boolean; uriPrefix?: string; nameContains?: string; limit?: number }): Promise<NotebookSummary[]>";
    }
    if (topic === "get") {
      return "notebooks.get(target?: { uri } | { handle: { uri, revision } }): Promise<NotebookDocument>. When target is omitted, returns the current notebook selected in the UI.";
    }
    if (topic === "update") {
      return "notebooks.update({ target, expectedRevision?, operations: NotebookMutation[] }): Promise<NotebookDocument>. target is required.";
    }
    if (topic === "delete") {
      return "notebooks.delete(target): Promise<void>. target is required.";
    }
    if (topic === "execute") {
      return "notebooks.execute({ target, refIds: string[] }): Promise<{ handle, cells }>. target is required.";
    }
    return [
      "Notebook SDK methods:",
      "- notebooks.list(query?)",
      "- notebooks.get(target?)              # omitted target = current UI notebook",
      "- notebooks.update({ target, expectedRevision?, operations })",
      "- notebooks.delete(target)",
      "- notebooks.execute({ target, refIds })",
      "- notebooks.help(topic?)",
    ].join("\n");
  };

  return {
    help,
    list: async (query?: NotebookQuery) => {
      const all = listKnownNotebooks();
      let result = all.map((notebook) => ({
        uri: notebook.getUri(),
        name: notebook.getName(),
        isOpen: true,
        source: inferNotebookSource(notebook.getUri()),
      }));
      if (query?.uriPrefix) {
        result = result.filter((item) => item.uri.startsWith(query.uriPrefix!));
      }
      if (query?.nameContains) {
        const needle = query.nameContains.toLowerCase();
        result = result.filter((item) => item.name.toLowerCase().includes(needle));
      }
      if (typeof query?.limit === "number" && query.limit >= 0) {
        result = result.slice(0, query.limit);
      }
      return result;
    },
    get: async (target?: NotebookTarget) => {
      const notebook = resolveNotebookByTarget(target);
      return makeDocument(notebook);
    },
    update: async (args) => {
      const notebook = resolveNotebookByRequiredTarget("update", args.target);
      const beforeHandle = makeHandle(notebook);
      if (
        args.expectedRevision &&
        args.expectedRevision.trim() !== "" &&
        args.expectedRevision !== beforeHandle.revision
      ) {
        throw new Error(
          `Revision mismatch: expected ${args.expectedRevision}, actual ${beforeHandle.revision}`,
        );
      }

      const operations = args.operations ?? [];
      if (!Array.isArray(operations)) {
        throw new Error(
          `Invalid notebooks.update operations: expected an array of notebook mutations, got ${JSON.stringify(
            operations,
          )}.`,
        );
      }

      for (const [index, operation] of operations.entries()) {
        if (operation.op === "insert") {
          insertCells(notebook, operation.at, operation.cells);
          continue;
        }
        if (operation.op === "update") {
          updateCellPatch(notebook, operation.refId, operation.patch);
          continue;
        }
        if (operation.op === "remove") {
          if (typeof notebook.removeCell !== "function") {
            throw new Error("Notebook does not support remove operations.");
          }
          for (const refId of operation.refIds ?? []) {
            notebook.removeCell(refId);
          }
          continue;
        }
        throw new Error(formatNotebookMutationError(index, operation));
      }

      return makeDocument(notebook);
    },
    delete: async (_target: NotebookTarget) => {
      resolveNotebookByRequiredTarget("delete", _target);
      throw new Error("notebooks.delete is not supported in v0 runtime.");
    },
    execute: async (args) => {
      const notebook = resolveNotebookByRequiredTarget("execute", args.target);
      const executedCells: parser_pb.Cell[] = [];
      for (const refId of args.refIds ?? []) {
        const cellRunner = notebook.getCell(refId);
        if (!cellRunner) {
          throw new Error(`Cell not found: ${refId}`);
        }
        const runResult = cellRunner.run();
        if (isPromiseLike(runResult)) {
          await runResult;
        }
        const cell = notebook.getNotebook().cells.find((candidate) => candidate.refId === refId);
        if (cell) {
          executedCells.push(cell);
        }
      }
      return {
        handle: makeHandle(notebook),
        cells: executedCells,
      };
    },
  };
}

function formatNotebookLabel(notebook: NotebookDataLike): string {
  const name = notebook.getName();
  const uri = notebook.getUri();
  if (name && name !== uri) {
    return `${name} (${uri})`;
  }
  return uri;
}

function clearCellRunMetadata(cell: parser_pb.Cell): void {
  if (!cell.metadata) {
    return;
  }
  delete cell.metadata[RunmeMetadataKey.LastRunID];
  delete cell.metadata[RunmeMetadataKey.Pid];
  delete cell.metadata[RunmeMetadataKey.ExitCode];
}

export function createRunmeConsoleApi({
  resolveNotebook,
}: {
  resolveNotebook: (target?: unknown) => NotebookDataLike | null;
}): RunmeConsoleApi {
  const getCurrentNotebook = () => resolveNotebook();

  const clearOutputs = (target?: unknown) => {
    const notebookData = resolveNotebook(target);
    if (!notebookData) {
      return "No active notebook found.";
    }

    const notebook = notebookData.getNotebook();
    const cells = notebook.cells ?? [];
    let updatedCells = 0;
    let clearedOutputs = 0;

    for (const cell of cells) {
      if (!cell?.refId) {
        continue;
      }
      const hasOutputs = (cell.outputs?.length ?? 0) > 0;
      const hasRunMetadata =
        typeof cell.metadata?.[RunmeMetadataKey.LastRunID] === "string" ||
        typeof cell.metadata?.[RunmeMetadataKey.Pid] === "string" ||
        typeof cell.metadata?.[RunmeMetadataKey.ExitCode] === "string";
      if (!hasOutputs && !hasRunMetadata) {
        continue;
      }

      const updatedCell = create(parser_pb.CellSchema, cell);
      clearedOutputs += updatedCell.outputs.length;
      updatedCell.outputs = [];
      clearCellRunMetadata(updatedCell);
      notebookData.updateCell(updatedCell);
      updatedCells += 1;
    }

    if (updatedCells === 0) {
      return `No cell outputs to clear in ${formatNotebookLabel(notebookData)}.`;
    }

    return `Cleared ${clearedOutputs} output item group(s) across ${updatedCells} cell(s) in ${formatNotebookLabel(notebookData)}.`;
  };

  const runAll = (target?: unknown) => {
    const notebookData = resolveNotebook(target);
    if (!notebookData) {
      return "No active notebook found.";
    }

    const notebook = notebookData.getNotebook();
    const cells = notebook.cells ?? [];
    let runnableCells = 0;
    let started = 0;
    let failedToStart = 0;

    for (const cell of cells) {
      if (!cell?.refId || cell.kind !== parser_pb.CellKind.CODE) {
        continue;
      }
      if ((cell.value ?? "").trim().length === 0) {
        continue;
      }
      runnableCells += 1;

      const cellData = notebookData.getCell(cell.refId);
      if (!cellData) {
        failedToStart += 1;
        continue;
      }

      const previousRunID = cellData.getRunID();
      cellData.run();
      const runID = cellData.getRunID();
      if (runID && runID !== previousRunID) {
        started += 1;
      } else {
        failedToStart += 1;
      }
    }

    if (runnableCells === 0) {
      return `No runnable code cells found in ${formatNotebookLabel(notebookData)}.`;
    }

    return `Started ${started}/${runnableCells} code cell(s) in ${formatNotebookLabel(notebookData)}.${failedToStart > 0 ? ` ${failedToStart} failed to start.` : ""}`;
  };

  const clear = (target?: unknown) => clearOutputs(target);
  const rerun = (target?: unknown) => {
    const notebookData = resolveNotebook(target);
    if (!notebookData) {
      return "No active notebook found.";
    }

    const clearMessage = clearOutputs(notebookData);
    const runMessage = runAll(notebookData);
    return `${clearMessage}\n${runMessage}`;
  };

  const help = () =>
    [
      "runme.clear()                  - Clear outputs in the current visible notebook",
      "runme.runAll()                 - Run all non-empty code cells in the current visible notebook",
      "runme.rerun()                  - Clear outputs, then run all cells in the current visible notebook",
      "runme.getCurrentNotebook()     - Advanced: return notebook handle for scripting",
      "runme.clearOutputs()           - Alias for runme.clear()",
      "",
      "Advanced optional target:",
      "  runme.clear(target)",
      "  runme.runAll(target)",
      "  runme.rerun(target)",
      "  target can be a notebook handle or notebook URI",
      "runme.help()                    - Show this help",
    ].join("\n");

  return {
    getCurrentNotebook,
    clear,
    clearOutputs,
    runAll,
    rerun,
    help,
  };
}
