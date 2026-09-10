# Execution output recovery

## User journey

An existing `.runme` notebook contains multiple completion records for the same
execution. The user must still be able to open it, edit its cells, save changes,
and run the affected cell again.

## Acceptance criteria

1. Causally ordered completion records retain the latest result, including late
   output. Wall-clock timestamps do not determine which result wins.
2. Concurrent records with identical results display that result. Concurrent
   records with conflicting results display a diagnostic in the affected cell's
   outputs. Malformed saved output also produces a cell-level diagnostic.
3. The notebook opens normally and remains writable. Other cells and source text
   remain available. The original operation history is preserved.
4. Edit the affected cell, save, and reload. The edit and diagnostic both remain.
   The diagnostic must not be appended as a real execution result.
5. Run the affected cell. The diagnostic clears, the new result appears, and a
   reload retains that result. A late finish from the old run cannot restore the
   diagnostic or overwrite the new output.

6. Explicitly clear the recovered outputs and reload. They remain cleared while
   the original finish records remain in history.
7. Export to IPYNB, legacy JSON, or Markdown. Display-only diagnostics are omitted;
   valid sibling outputs remain. Exporting must not change the editable model.

## Regression coverage

- `app/src/lib/operationLog/executionRecovery.test.ts` exercises causal ordering,
  concurrent conflicts, malformed output, source edits, and reruns.
- `app/src/storage/local.test.ts` exercises opening, saving, and reopening the
  damaged history through the real operation-log storage adapter.
- For browser verification, create a local JavaScript notebook with two
  conflicting finishes that both depend on the same start. Open it in the editor,
  type a source edit, reload, then use the Run button with the browser runner.
  Verify the rendered diagnostic and replacement output, and capture screenshots
  under `app/test/browser/test-output/`.
