import { create } from "@bufbuild/protobuf";

import { RunmeMetadataKey, parser_pb } from "../../runme/client";

type CellRunnerLike = {
  run: () => void;
  getRunID: () => string;
};

export type NotebookDataLike = {
  getUri: () => string;
  getName: () => string;
  getNotebook: () => parser_pb.Notebook;
  updateCell: (cell: parser_pb.Cell) => void;
  getCell: (refId: string) => CellRunnerLike | null;
};

export type RunmeConsoleApi = {
  getCurrentNotebook: () => NotebookDataLike | null;
  clearOutputs: (target?: unknown) => string;
  runAll: (target?: unknown) => string;
  help: () => string;
};

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

  const help = () =>
    [
      "runme.getCurrentNotebook()      - Return the active notebook handle",
      "runme.clearOutputs([notebookOrUri]) - Clear all outputs in a notebook",
      "runme.runAll([notebookOrUri])       - Run all non-empty code cells",
      "runme.help()                    - Show this help",
    ].join("\n");

  return {
    getCurrentNotebook,
    clearOutputs,
    runAll,
    help,
  };
}
