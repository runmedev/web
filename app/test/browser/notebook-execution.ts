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
