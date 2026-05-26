import md5 from "md5";

import { MimeType, RunmeMetadataKey, parser_pb } from "../../runme/client";
import {
  type CellDiff,
  type MetadataDiff,
  type NotebookDiff,
  type NotebookDiffOptions,
  type OutputDiff,
  type OutputItemSummary,
  type TextDiff,
  type TextDiffLine,
} from "./model";

const DEFAULT_OPTIONS: Required<NotebookDiffOptions> = {
  includeOutputs: true,
  includeMetadata: true,
  ignoreTransientMetadata: true,
};

const INTERNAL_OUTPUT_MIMES = new Set<string>([
  MimeType.StatefulRunmeOutputItems,
  MimeType.StatefulRunmeTerminal,
]);

const TEXT_DECODER = new TextDecoder();
const MAX_OUTPUT_TEXT_DIFF_BYTES = 100_000;
const MAX_OUTPUT_TEXT_DIFF_LINES = 500;

const TRANSIENT_METADATA_KEYS = new Set<string>([
  RunmeMetadataKey.Sequence,
  RunmeMetadataKey.LastRunID,
  RunmeMetadataKey.Pid,
  RunmeMetadataKey.ExitCode,
]);

type IndexedCell = {
  cell: parser_pb.Cell;
  index: number;
};

type CellMatch = {
  base: IndexedCell;
  compare: IndexedCell;
};

export function computeNotebookDiff(
  baseNotebook: parser_pb.Notebook,
  compareNotebook: parser_pb.Notebook,
  options: NotebookDiffOptions = {},
): NotebookDiff {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  const baseCells = (baseNotebook.cells ?? []).map((cell, index) => ({
    cell,
    index,
  }));
  const compareCells = (compareNotebook.cells ?? []).map((cell, index) => ({
    cell,
    index,
  }));
  const matches = matchCells(baseCells, compareCells);
  const compareRefToMatch = new Map<string, CellMatch>();
  const baseRefToMatch = new Map<string, CellMatch>();
  for (const match of matches) {
    compareRefToMatch.set(cellKey(match.compare.cell, match.compare.index), match);
    baseRefToMatch.set(cellKey(match.base.cell, match.base.index), match);
  }

  const rows: CellDiff[] = [];
  let baseCursor = 0;
  for (const compare of compareCells) {
    const match = compareRefToMatch.get(cellKey(compare.cell, compare.index));
    if (!match) {
      rows.push(createInsertedCellDiff(compare));
      continue;
    }

    while (baseCursor < match.base.index) {
      const base = baseCells[baseCursor];
      if (!baseRefToMatch.has(cellKey(base.cell, base.index))) {
        rows.push(createDeletedCellDiff(base));
      }
      baseCursor += 1;
    }

    rows.push(createMatchedCellDiff(match, resolvedOptions));
    baseCursor = Math.max(baseCursor, match.base.index + 1);
  }

  while (baseCursor < baseCells.length) {
    const base = baseCells[baseCursor];
    if (!baseRefToMatch.has(cellKey(base.cell, base.index))) {
      rows.push(createDeletedCellDiff(base));
    }
    baseCursor += 1;
  }

  return {
    cells: rows,
    summary: summarize(rows),
  };
}

function matchCells(
  baseCells: IndexedCell[],
  compareCells: IndexedCell[],
): CellMatch[] {
  const matches: CellMatch[] = [];
  const usedBaseIndexes = new Set<number>();
  const usedCompareIndexes = new Set<number>();

  const baseByRef = uniqueRefMap(baseCells);
  const compareByRef = uniqueRefMap(compareCells);
  for (const [refId, base] of baseByRef.entries()) {
    const compare = compareByRef.get(refId);
    if (!compare) {
      continue;
    }
    matches.push({ base, compare });
    usedBaseIndexes.add(base.index);
    usedCompareIndexes.add(compare.index);
  }

  const exactBase = new Map<string, IndexedCell[]>();
  for (const base of baseCells) {
    if (usedBaseIndexes.has(base.index)) {
      continue;
    }
    const key = authoredCellKey(base.cell);
    exactBase.set(key, [...(exactBase.get(key) ?? []), base]);
  }

  for (const compare of compareCells) {
    if (usedCompareIndexes.has(compare.index)) {
      continue;
    }
    const key = authoredCellKey(compare.cell);
    const candidates = exactBase.get(key) ?? [];
    const base = candidates.find((candidate) => !usedBaseIndexes.has(candidate.index));
    if (!base) {
      continue;
    }
    matches.push({ base, compare });
    usedBaseIndexes.add(base.index);
    usedCompareIndexes.add(compare.index);
  }

  matches.sort((a, b) => a.compare.index - b.compare.index);
  return matches;
}

function uniqueRefMap(cells: IndexedCell[]): Map<string, IndexedCell> {
  const counts = new Map<string, number>();
  for (const { cell } of cells) {
    if (!cell.refId) {
      continue;
    }
    counts.set(cell.refId, (counts.get(cell.refId) ?? 0) + 1);
  }

  const result = new Map<string, IndexedCell>();
  for (const item of cells) {
    if (item.cell.refId && counts.get(item.cell.refId) === 1) {
      result.set(item.cell.refId, item);
    }
  }
  return result;
}

function createInsertedCellDiff(compare: IndexedCell): CellDiff {
  return {
    id: `inserted:${compare.cell.refId || compare.index}`,
    kind: "inserted",
    compareIndex: compare.index,
    compareCell: compare.cell,
    moved: false,
    changedFields: ["source"],
  };
}

function createDeletedCellDiff(base: IndexedCell): CellDiff {
  return {
    id: `deleted:${base.cell.refId || base.index}`,
    kind: "deleted",
    baseIndex: base.index,
    baseCell: base.cell,
    moved: false,
    changedFields: ["source"],
  };
}

function createMatchedCellDiff(
  match: CellMatch,
  options: Required<NotebookDiffOptions>,
): CellDiff {
  const sourceDiff = diffText(match.base.cell.value ?? "", match.compare.cell.value ?? "");
  const metadataDiff = options.includeMetadata
    ? diffMetadata(match.base.cell, match.compare.cell, options)
    : undefined;
  const outputDiff = options.includeOutputs
    ? diffOutputs(match.base.cell, match.compare.cell)
    : undefined;
  const moved = match.base.index !== match.compare.index;
  const changedFields: CellDiff["changedFields"] = [];

  if (sourceDiff.changed) {
    changedFields.push("source");
  }
  if (metadataDiff?.changed) {
    changedFields.push("metadata");
  }
  if (outputDiff?.changed) {
    changedFields.push("outputs");
  }
  if (match.base.cell.kind !== match.compare.cell.kind) {
    changedFields.push("kind");
  }
  if ((match.base.cell.languageId ?? "") !== (match.compare.cell.languageId ?? "")) {
    changedFields.push("language");
  }
  if (moved) {
    changedFields.push("move");
  }

  return {
    id: match.base.cell.refId || match.compare.cell.refId || `matched:${match.base.index}:${match.compare.index}`,
    kind: changedFields.length > 0 ? "modified" : "unchanged",
    baseIndex: match.base.index,
    compareIndex: match.compare.index,
    baseCell: match.base.cell,
    compareCell: match.compare.cell,
    moved,
    sourceDiff,
    metadataDiff,
    outputDiff,
    changedFields,
  };
}

export function diffText(baseText: string, compareText: string): TextDiff {
  if (baseText === compareText) {
    return {
      changed: false,
      lines: splitLines(baseText).map((line) => ({
        kind: "equal",
        baseLine: line,
        compareLine: line,
      })),
    };
  }

  const baseLines = splitLines(baseText);
  const compareLines = splitLines(compareText);
  const table = buildLcsTable(baseLines, compareLines);
  const lines: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < baseLines.length && j < compareLines.length) {
    if (baseLines[i] === compareLines[j]) {
      lines.push({
        kind: "equal",
        baseLine: baseLines[i],
        compareLine: compareLines[j],
      });
      i += 1;
      j += 1;
    } else if (table[i + 1]?.[j] >= table[i]?.[j + 1]) {
      lines.push({ kind: "removed", baseLine: baseLines[i] });
      i += 1;
    } else {
      lines.push({ kind: "added", compareLine: compareLines[j] });
      j += 1;
    }
  }
  while (i < baseLines.length) {
    lines.push({ kind: "removed", baseLine: baseLines[i] });
    i += 1;
  }
  while (j < compareLines.length) {
    lines.push({ kind: "added", compareLine: compareLines[j] });
    j += 1;
  }
  return { changed: true, lines };
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

function buildLcsTable(baseLines: string[], compareLines: string[]): number[][] {
  const table = Array.from({ length: baseLines.length + 1 }, () =>
    Array.from({ length: compareLines.length + 1 }, () => 0),
  );
  for (let i = baseLines.length - 1; i >= 0; i -= 1) {
    for (let j = compareLines.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        baseLines[i] === compareLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function diffMetadata(
  baseCell: parser_pb.Cell,
  compareCell: parser_pb.Cell,
  options: Required<NotebookDiffOptions>,
): MetadataDiff {
  const base = normalizeMetadata(baseCell.metadata ?? {}, options);
  const compare = normalizeMetadata(compareCell.metadata ?? {}, options);
  return {
    changed: stableStringify(base) !== stableStringify(compare),
    base,
    compare,
  };
}

function normalizeMetadata(
  metadata: Record<string, string>,
  options: Required<NotebookDiffOptions>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (options.ignoreTransientMetadata && TRANSIENT_METADATA_KEYS.has(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function diffOutputs(baseCell: parser_pb.Cell, compareCell: parser_pb.Cell): OutputDiff {
  const baseItems = summarizeOutputs(baseCell.outputs ?? []);
  const compareItems = summarizeOutputs(compareCell.outputs ?? []);
  const baseSerialized = stableStringify(baseItems);
  const compareSerialized = stableStringify(compareItems);
  const changed = baseSerialized !== compareSerialized;
  const baseText = baseItems
    .filter((item) => item.kind === "text")
    .map((item) => `[${item.mime}]\n${item.text ?? ""}`)
    .join("\n\n");
  const compareText = compareItems
    .filter((item) => item.kind === "text")
    .map((item) => `[${item.mime}]\n${item.text ?? ""}`)
    .join("\n\n");
  return {
    changed,
    baseItems,
    compareItems,
    textDiff: maybeDiffOutputText(baseText, compareText),
  };
}

function maybeDiffOutputText(
  baseText: string,
  compareText: string,
): TextDiff | undefined {
  if (!baseText && !compareText) {
    return undefined;
  }
  if (baseText.length + compareText.length > MAX_OUTPUT_TEXT_DIFF_BYTES) {
    return undefined;
  }
  const baseLineCount = countLines(baseText);
  const compareLineCount = countLines(compareText);
  if (
    baseLineCount > MAX_OUTPUT_TEXT_DIFF_LINES ||
    compareLineCount > MAX_OUTPUT_TEXT_DIFF_LINES
  ) {
    return undefined;
  }
  return diffText(baseText, compareText);
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

function summarizeOutputs(outputs: parser_pb.CellOutput[]): OutputItemSummary[] {
  return outputs.flatMap((output) =>
    (output.items ?? [])
      .filter((item) => {
        const mime = (item.mime ?? "").trim();
        return mime && !INTERNAL_OUTPUT_MIMES.has(mime);
      })
      .map((item) => summarizeOutputItem(item)),
  );
}

function summarizeOutputItem(item: parser_pb.CellOutputItem): OutputItemSummary {
  const mime = (item.mime ?? "").trim();
  const bytes = normalizeBytes(item.data);
  const checksum = md5(Array.from(bytes).join(","));
  if (isTextLikeMime(mime)) {
    return {
      mime,
      kind: "text",
      text: decodeText(bytes),
      sizeBytes: bytes.byteLength,
      checksum,
    };
  }
  return {
    mime,
    kind: "binary",
    sizeBytes: bytes.byteLength,
    checksum,
  };
}

function normalizeBytes(data?: Uint8Array | ArrayLike<number> | null): Uint8Array {
  if (!data) {
    return new Uint8Array();
  }
  return data instanceof Uint8Array ? data : Uint8Array.from(data);
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return "";
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    return "";
  }
}

function isTextLikeMime(mime: string): boolean {
  return (
    mime === MimeType.VSCodeNotebookStdOut ||
    mime === MimeType.VSCodeNotebookStdErr ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/javascript" ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/sql" ||
    mime === "application/yaml" ||
    mime === "application/x-yaml"
  );
}

function authoredCellKey(cell: parser_pb.Cell): string {
  return stableStringify({
    kind: cell.kind,
    languageId: cell.languageId ?? "",
    value: cell.value ?? "",
  });
}

function cellKey(cell: parser_pb.Cell, index: number): string {
  return cell.refId || `index:${index}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function summarize(rows: CellDiff[]): NotebookDiff["summary"] {
  return rows.reduce<NotebookDiff["summary"]>(
    (summary, row) => {
      if (row.kind === "unchanged") {
        summary.unchangedCells += 1;
      }
      if (row.kind === "inserted") {
        summary.insertedCells += 1;
      }
      if (row.kind === "deleted") {
        summary.deletedCells += 1;
      }
      if (row.kind === "modified") {
        summary.modifiedCells += 1;
      }
      if (row.moved) {
        summary.movedCells += 1;
      }
      if (row.changedFields.includes("source")) {
        summary.sourceChanges += 1;
      }
      if (row.changedFields.includes("metadata")) {
        summary.metadataChanges += 1;
      }
      if (row.changedFields.includes("outputs")) {
        summary.outputChanges += 1;
      }
      return summary;
    },
    {
      unchangedCells: 0,
      insertedCells: 0,
      deletedCells: 0,
      modifiedCells: 0,
      movedCells: 0,
      sourceChanges: 0,
      metadataChanges: 0,
      outputChanges: 0,
    },
  );
}
