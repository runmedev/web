# Recover a failed Colab export

## Goal

A failed generated `.ipynb` copy must recover independently of the saved
`.runme` source. Upgrading the app or reconnecting Drive must not require a
meaningless source edit to retry an old export failure.

## Journey

1. Enable automatic Colab export on a Drive-backed V2 `.runme` notebook.
2. Allow the source to sync, then fail its derived export (for example, lose
   Drive connectivity). The source remains saved and editable.
3. Open Notebook properties. Verify the export error appears without the
   generic waiting-for-export message.
4. Restore Drive connectivity. Verify the failed export is queued even though
   the source has no pending edits. An error persisted by an older client,
   including `Unsupported notebook log format_version 2`, follows this path.
5. Alternatively, click **Retry Colab export**. Verify the button shows progress,
   failures remain visible, and another retry is possible.
6. On success, verify the generated copy contains the latest committed content,
   the error clears, and the existing copy is reused.
7. Verify unconfirmed creates retain their separate explicit recovery action;
   the ordinary retry button must not bypass that flow.

## Regression coverage

`app/src/storage/local.test.ts` covers reconnect eligibility, V2 conversion,
clearing an old error, and reuse of the derived copy.
`app/src/components/NotebookPropertiesDialog.test.tsx` covers direct retry,
retry failure, source immutability during export retry, and unconfirmed-create
isolation. These are unit regressions; this journey has no dedicated browser
script yet.
