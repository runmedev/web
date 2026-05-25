import { Badge, Button, ScrollArea, Text } from "@radix-ui/themes";
import { Link, useParams } from "react-router-dom";

import { parser_pb } from "../../runme/client";
import { getNotebookDiffDocument } from "../../lib/notebookDiff/registry";
import type {
  CellDiff,
  NotebookDiffDocument,
  OutputItemSummary,
  TextDiff,
  TextDiffLine,
} from "../../lib/notebookDiff/model";

function cellKindLabel(cell?: parser_pb.Cell): string {
  if (!cell) {
    return "";
  }
  if (cell.kind === parser_pb.CellKind.MARKUP) {
    return "Markdown";
  }
  if (cell.kind === parser_pb.CellKind.CODE) {
    return cell.languageId || "Code";
  }
  return cell.languageId || "Cell";
}

function changeBadgeColor(kind: CellDiff["kind"]): "gray" | "green" | "red" | "amber" {
  switch (kind) {
    case "inserted":
      return "green";
    case "deleted":
      return "red";
    case "modified":
      return "amber";
    default:
      return "gray";
  }
}

function statusText(row: CellDiff): string {
  if (row.kind === "inserted") {
    return "Inserted";
  }
  if (row.kind === "deleted") {
    return "Deleted";
  }
  if (row.kind === "unchanged") {
    return row.moved ? "Moved" : "Unchanged";
  }
  return row.changedFields
    .map((field) => (field === "move" ? "moved" : field))
    .join(", ");
}

function lineClass(line: TextDiffLine, side: "base" | "compare"): string {
  if (line.kind === "equal") {
    return "text-nb-text";
  }
  if (side === "base" && line.kind === "removed") {
    return "bg-red-50 text-red-900";
  }
  if (side === "compare" && line.kind === "added") {
    return "bg-emerald-50 text-emerald-900";
  }
  return "text-nb-text-faint";
}

function lineText(line: TextDiffLine, side: "base" | "compare"): string {
  if (side === "base") {
    return line.baseLine ?? "";
  }
  return line.compareLine ?? "";
}

function SourceDiff({
  diff,
  side,
  fallback,
}: {
  diff?: TextDiff;
  side: "base" | "compare";
  fallback: string;
}) {
  const lines =
    diff?.lines.length ? diff.lines : fallback ? fallback.split(/\r?\n/) : [];
  return (
    <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
      {lines.length === 0 ? (
        <span className="text-nb-text-faint">No source</span>
      ) : (
        lines.map((line, index) => {
          const normalizedLine =
            typeof line === "string"
              ? ({ kind: "equal", baseLine: line, compareLine: line } as TextDiffLine)
              : line;
          return (
            <div
              key={`${side}-line-${index}`}
              className={`min-h-5 rounded px-1 ${lineClass(normalizedLine, side)}`}
            >
              {lineText(normalizedLine, side) || " "}
            </div>
          );
        })
      )}
    </pre>
  );
}

function OutputSummary({
  items,
  side,
}: {
  items: OutputItemSummary[];
  side: "base" | "compare";
}) {
  if (items.length === 0) {
    return <div className="text-xs text-nb-text-faint">No outputs</div>;
  }
  return (
    <details className="rounded border border-nb-border bg-nb-surface-2 p-2 text-xs" open={false}>
      <summary className="cursor-pointer text-nb-text-muted">
        {items.length} output item{items.length === 1 ? "" : "s"} on {side}
      </summary>
      <div className="mt-2 space-y-2">
        {items.map((item, index) => (
          <div key={`${side}-output-${index}`} className="rounded bg-white p-2">
            <div className="font-mono text-[11px] text-nb-text-muted">
              {item.mime} · {item.kind} · {item.sizeBytes} bytes
            </div>
            {item.text && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-nb-text">
                {item.text}
              </pre>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function CellPanel({
  row,
  side,
}: {
  row: CellDiff;
  side: "base" | "compare";
}) {
  const cell = side === "base" ? row.baseCell : row.compareCell;
  const empty =
    (side === "base" && row.kind === "inserted") ||
    (side === "compare" && row.kind === "deleted");
  const outputItems =
    side === "base"
      ? row.outputDiff?.baseItems ?? []
      : row.outputDiff?.compareItems ?? [];

  if (empty) {
    return (
      <div className="flex min-h-28 items-center justify-center rounded border border-dashed border-nb-border bg-nb-surface-2 text-sm text-nb-text-faint">
        No cell on this side
      </div>
    );
  }

  return (
    <div className="min-w-0 rounded border border-nb-border bg-white">
      <div className="flex items-center justify-between border-b border-nb-border bg-nb-surface-2 px-3 py-2">
        <span className="text-xs font-medium text-nb-text-muted">
          {cellKindLabel(cell)}
        </span>
        <span className="font-mono text-[11px] text-nb-text-faint">
          {cell?.refId || "no-ref"}
        </span>
      </div>
      <SourceDiff
        diff={row.sourceDiff}
        side={side}
        fallback={cell?.value ?? ""}
      />
      {row.outputDiff?.changed && (
        <div className="border-t border-nb-border p-3">
          <OutputSummary items={outputItems} side={side} />
        </div>
      )}
    </div>
  );
}

function DiffRow({ row }: { row: CellDiff }) {
  if (row.kind === "unchanged") {
    return (
      <details className="rounded border border-nb-border bg-nb-surface-2 px-3 py-2 text-sm text-nb-text-muted">
        <summary className="cursor-pointer">
          Unchanged cell {row.baseCell?.refId || row.compareCell?.refId || ""}
        </summary>
      </details>
    );
  }

  return (
    <section className="rounded-lg border border-nb-border bg-nb-bg p-3 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Badge color={changeBadgeColor(row.kind)}>{statusText(row)}</Badge>
        {row.outputDiff?.changed && <Badge color="blue">outputs changed</Badge>}
        {row.metadataDiff?.changed && <Badge color="purple">metadata changed</Badge>}
      </div>
      <div className="grid min-w-[920px] grid-cols-2 gap-3">
        <CellPanel row={row} side="base" />
        <CellPanel row={row} side="compare" />
      </div>
    </section>
  );
}

function NotebookDiffContent({ document }: { document: NotebookDiffDocument }) {
  const { diff } = document;
  return (
    <div className="flex h-screen w-screen flex-col bg-nb-surface">
      <header className="border-b border-nb-border bg-white px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Text as="p" size="5" weight="bold" className="text-nb-text">
              Notebook Diff
            </Text>
            <Text as="p" size="2" className="text-nb-text-muted">
              {document.base.label} compared with {document.compare.label}
            </Text>
          </div>
          <Button asChild variant="soft">
            <Link to="/">Back to notebooks</Link>
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-sm text-nb-text-muted">
          <Badge color="green">{diff.summary.insertedCells} inserted</Badge>
          <Badge color="red">{diff.summary.deletedCells} deleted</Badge>
          <Badge color="amber">{diff.summary.modifiedCells} modified</Badge>
          <Badge color="blue">{diff.summary.outputChanges} output changes</Badge>
          <Badge color="gray">{diff.summary.unchangedCells} unchanged</Badge>
        </div>
        <div className="mt-4 grid min-w-[920px] grid-cols-2 gap-3 overflow-x-auto text-xs font-medium uppercase tracking-wide text-nb-text-muted">
          <div className="rounded border border-nb-border bg-nb-surface-2 px-3 py-2">
            Base: {document.base.label}
          </div>
          <div className="rounded border border-nb-border bg-nb-surface-2 px-3 py-2">
            Compare: {document.compare.label}
          </div>
        </div>
      </header>
      <ScrollArea type="auto" scrollbars="both" className="min-h-0 flex-1">
        <div className="space-y-3 p-5">
          {diff.cells.map((row) => (
            <DiffRow key={row.id} row={row} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export default function NotebookDiffView() {
  const params = useParams<{ diffId: string }>();
  const document = params.diffId
    ? getNotebookDiffDocument(decodeURIComponent(params.diffId))
    : null;

  if (!document) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-nb-surface text-center">
        <Text as="p" size="4" weight="bold">
          Diff no longer available
        </Text>
        <Text as="p" size="2" className="max-w-md text-nb-text-muted">
          Recompute the notebook diff from a browser JavaScript cell, then call
          notebookDiff.openDiffTab(diff) again.
        </Text>
        <Button asChild variant="soft">
          <Link to="/">Back to notebooks</Link>
        </Button>
      </div>
    );
  }

  return <NotebookDiffContent document={document} />;
}
