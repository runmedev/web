export type NotebookProbeCellLike = {
  refId?: string;
  lastRunID?: string;
  exitCode?: string;
};

export type NotebookProbeLike<TCell extends NotebookProbeCellLike = NotebookProbeCellLike> = {
  status?: string;
  cells?: TCell[];
};

export type WaitForCellExecutionResult<
  TProbe extends NotebookProbeLike<TCell>,
  TCell extends NotebookProbeCellLike,
> = {
  ok: boolean;
  reason: "completed" | "timeout-waiting-start" | "timeout-waiting-finish";
  runID: string;
  elapsedMs: number;
  probe: TProbe;
  cell?: TCell;
};

export type WaitForCellExecutionOptions<
  TProbe extends NotebookProbeLike<TCell>,
  TCell extends NotebookProbeCellLike,
> = {
  cellRefId: string;
  previousRunID?: string;
  timeoutMs?: number;
  pollMs?: number;
  expectedProbeStatus?: string;
  probe: () => TProbe;
  wait: (ms: number) => void;
};

export type NotebookScrollOptions = {
  evaluate: (script: string) => string;
  wait?: (ms: number) => void;
  settleMs?: number;
};

function escapeSingleQuotedJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function settleAfterScroll(wait: ((ms: number) => void) | undefined, settleMs: number): void {
  if (!wait) {
    return;
  }
  const ms = Number.isFinite(settleMs) && settleMs > 0 ? Math.floor(settleMs) : 0;
  if (ms > 0) {
    wait(ms);
  }
}

/**
 * Scroll so the target cell's toolbar (cell top) is aligned near the viewport top.
 */
export function scrollToTopOfCell(
  cellRefId: string,
  options: NotebookScrollOptions,
): boolean {
  const { evaluate, wait, settleMs = 120 } = options;
  const escapedCellRefId = escapeSingleQuotedJs(cellRefId);
  const result = evaluate(`(() => {
    const toolbar = document.getElementById('cell-toolbar-${escapedCellRefId}');
    const runButton = toolbar?.querySelector('button[aria-label^="Run"]');
    const action = document.getElementById('code-action-${escapedCellRefId}');
    const output = document.getElementById('cell-output-${escapedCellRefId}');
    const target = toolbar || runButton || action || output;
    if (!target) return 'missing';
    target.scrollIntoView({ block: 'start', inline: 'nearest' });
    return 'ok';
  })()`);
  const ok = result.includes("ok");
  if (ok) {
    settleAfterScroll(wait, settleMs);
  }
  return ok;
}

/**
 * Scroll notebook/document view to its bottom to keep freshly appended output visible.
 */
export function scrollToBottomOfNotebook(options: NotebookScrollOptions): boolean {
  const { evaluate, wait, settleMs = 120 } = options;
  const result = evaluate(`(() => {
    const notebookRoot = document.getElementById('documents');
    if (notebookRoot && notebookRoot.scrollHeight > notebookRoot.clientHeight) {
      notebookRoot.scrollTop = notebookRoot.scrollHeight;
    }
    const docHeight = Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0
    );
    window.scrollTo({ top: docHeight, left: 0, behavior: 'auto' });
    return 'ok';
  })()`);
  const ok = result.includes("ok");
  if (ok) {
    settleAfterScroll(wait, settleMs);
  }
  return ok;
}

/**
 * Wait for a single notebook cell execution to reach a terminal state.
 *
 * The helper intentionally separates "execution started" from "execution finished":
 * 1) Start is detected only when `lastRunID` changes to a new non-empty value
 *    compared to `previousRunID`.
 * 2) Finish is detected only when the same run has a non-empty `exitCode`.
 *
 * This avoids a common race where tests proceed as soon as `lastRunID` appears.
 * `lastRunID` is set at run start, not completion, so the cell may still be running.
 *
 * The caller is responsible for validating semantic success (output text, specific
 * metadata, expected exit code value, etc.) after this function reports completion.
 */
export function waitForCellExecution<
  TProbe extends NotebookProbeLike<TCell>,
  TCell extends NotebookProbeCellLike,
>(options: WaitForCellExecutionOptions<TProbe, TCell>): WaitForCellExecutionResult<TProbe, TCell> {
  const {
    cellRefId,
    previousRunID = "",
    timeoutMs = 60000,
    pollMs = 300,
    expectedProbeStatus = "ok",
    probe,
    wait,
  } = options;

  const startedAtMs = Date.now();
  const priorRunID = String(previousRunID ?? "").trim();
  let observedRunID = "";
  let lastProbe = probe();
  let lastCell = lastProbe.cells?.find((cell) => cell?.refId === cellRefId);

  while (Date.now() - startedAtMs < timeoutMs) {
    const currentProbe = probe();
    const currentCell = currentProbe.cells?.find((cell) => cell?.refId === cellRefId);

    lastProbe = currentProbe;
    lastCell = currentCell;

    if (currentProbe.status === expectedProbeStatus && currentCell) {
      const currentRunID = String(currentCell.lastRunID ?? "").trim();
      const currentExitCode = String(currentCell.exitCode ?? "").trim();

      if (!observedRunID && currentRunID.length > 0 && currentRunID !== priorRunID) {
        observedRunID = currentRunID;
      }

      if (
        observedRunID.length > 0 &&
        currentRunID === observedRunID &&
        currentExitCode.length > 0
      ) {
        return {
          ok: true,
          reason: "completed",
          runID: observedRunID,
          elapsedMs: Date.now() - startedAtMs,
          probe: currentProbe,
          cell: currentCell,
        };
      }
    }

    wait(pollMs);
  }

  return {
    ok: false,
    reason: observedRunID.length > 0 ? "timeout-waiting-finish" : "timeout-waiting-start",
    runID: observedRunID,
    elapsedMs: Date.now() - startedAtMs,
    probe: lastProbe,
    cell: lastCell,
  };
}
