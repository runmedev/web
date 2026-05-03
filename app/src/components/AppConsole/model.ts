import { create } from "@bufbuild/protobuf";

import { MimeType, parser_pb } from "../../runme/client";

export type ConsoleCellStatus = "draft" | "running" | "success" | "error";

export type ConsoleCell = {
  id: string;
  index: number;
  source: string;
  status: ConsoleCellStatus;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  outputs: parser_pb.CellOutput[];
};

export type PersistedConsoleSessionRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type PersistedConsoleCellRow = ConsoleCell & {
  sessionId: string;
  updatedAt: string;
};

const textEncoder = new TextEncoder();

function encodeOutputText(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function createDraftCell(index: number, source = ""): ConsoleCell {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `app-console-${index}-${Date.now()}`,
    index,
    source,
    status: "draft",
    outputs: [],
  };
}

export function createTextOutputItem(
  mime: string,
  text: string,
): parser_pb.CellOutputItem {
  return create(parser_pb.CellOutputItemSchema, {
    mime,
    type: "Buffer",
    data: encodeOutputText(text),
  });
}

export function createStdTextOutputs(
  stdout: string,
  stderr: string,
): parser_pb.CellOutput[] {
  if (!stdout && !stderr) {
    return [];
  }

  return [
    create(parser_pb.CellOutputSchema, {
      items: [
        createTextOutputItem(MimeType.VSCodeNotebookStdOut, stdout),
        createTextOutputItem(MimeType.VSCodeNotebookStdErr, stderr),
      ],
    }),
  ];
}

export function createResultOutput(result: unknown): parser_pb.CellOutput[] {
  if (typeof result === "undefined") {
    return [];
  }

  const text =
    typeof result === "string"
      ? result
      : (() => {
          try {
            return JSON.stringify(
              result,
              (_key, value) => (typeof value === "bigint" ? value.toString() : value),
              2,
            );
          } catch {
            return String(result);
          }
        })();

  return [
    create(parser_pb.CellOutputSchema, {
      items: [createTextOutputItem("text/plain", `${text}\n`)],
    }),
  ];
}

export function appendRecoveryNote(
  outputs: parser_pb.CellOutput[],
  note: string,
): parser_pb.CellOutput[] {
  const recovered = createStdTextOutputs("", note);
  if (recovered.length === 0) {
    return outputs;
  }
  return [...outputs, ...recovered];
}

export function coerceRestoredCells(
  rows: PersistedConsoleCellRow[],
  now: string,
): { cells: ConsoleCell[]; mutated: boolean } {
  let mutated = false;
  const sorted = [...rows].sort((left, right) => left.index - right.index);
  const cells = sorted.map<ConsoleCell>((row) => {
    if (row.status !== "running") {
      return {
        id: row.id,
        index: row.index,
        source: row.source,
        status: row.status,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        exitCode: row.exitCode,
        outputs: row.outputs ?? [],
      };
    }

    mutated = true;
    return {
      id: row.id,
      index: row.index,
      source: row.source,
      status: "error",
      startedAt: row.startedAt,
      completedAt: now,
      exitCode: 1,
      outputs: appendRecoveryNote(
        row.outputs ?? [],
        "[runme] App Console execution was interrupted by a page reload.\n",
      ),
    };
  });

  const draftCells = cells.filter((cell) => cell.status === "draft");
  if (draftCells.length === 0) {
    mutated = true;
    const nextIndex = cells.length > 0 ? cells[cells.length - 1].index + 1 : 1;
    cells.push(createDraftCell(nextIndex));
  } else if (draftCells.length > 1) {
    mutated = true;
    const latestDraftId = draftCells[draftCells.length - 1].id;
    for (let i = 0; i < cells.length; i += 1) {
      if (cells[i].status === "draft" && cells[i].id !== latestDraftId) {
        cells[i] = {
          ...cells[i],
          status: "error",
          completedAt: now,
          exitCode: 1,
          outputs: appendRecoveryNote(
            cells[i].outputs,
            "[runme] Recovered duplicate draft cell after reload.\n",
          ),
        };
      }
    }
  }

  return { cells, mutated };
}

export function getHistorySources(cells: ConsoleCell[]): string[] {
  return cells
    .filter((cell) => cell.status !== "draft")
    .map((cell) => cell.source)
    .filter((source) => source.trim() !== "");
}
