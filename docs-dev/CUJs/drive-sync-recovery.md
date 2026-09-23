# Drive sync recovery CUJ

## Goal

Recover failed saves, exports and notebook creations without another local edit.
Preserve content and existing conflict handling. See the
[design](../design/20260923_drive_sync_recovery.md).

## Automated coverage

- `local.test.ts`: format-correct predicates, unchanged/empty failed downloads,
  OPFS checksum repair, concurrent metadata publication, corrupt-log isolation,
  retry reconstruction, durable creation payloads, changed-input key rejection,
  corrupt-payload preservation, receipt retention and cross-controller serialization.
- `syncWorkQueue.test.ts`: coalescing, dirty-during-processing, save interval,
  delayed backoff, no starvation, credential wake-up and explicit/background joins.
- `driveTransfer.test.ts`: idempotent creation engine, interrupted create/adoption,
  version validation, durable Save As entry point and opening only for callers.
- `driveResyncReconciler.test.ts`: startup/auth/online/timer and cleanup.
- `DriveSyncStatusTab.test.tsx`: error/attempt/success status and pending-create retry.
- `notebookData.test.ts` and `appJsGlobals.test.ts`: AppKernel creation/Save As callers.

## Live acceptance (not performed by the automated suite)

Use disposable notebooks and a development build, not production failure injection.
Record the commit, origin, identity type (no tokens), status and upstream contents.

1. Save `.runme`, `.json` and `.ipynb`; inject an auth/network failure. Restore the
   dependency without an edit. Verify delayed retry and cleared error after success.
   Close/reopen the tab and repeat: unfinished state survives, retry clock resets.
2. Fail the first download with empty checksums. Verify recovery downloads the
   original content and never uploads/creates an empty notebook.
3. Remove a cached `.runme` hash in a test record. Verify backfill uses OPFS and
   preserves a concurrently published hash. Corrupt a separate disposable log;
   confirm other files and status still work and original bytes remain preserved.
4. Burst edits and periodic wake-ups. Verify one queued key, no continually pushed
   deadline, a subsequent pass for edits during upload, and the two-minute automatic
   interval. Manual retry may bypass delay but still uses the shared lock.
5. Run two same-origin tabs, including source, IPYNB export and direct-create work.
   Verify at most one active attempt. Close the active tab and confirm recovery.
   A blocked key must not prevent other ready keys; conflicts must not be overwritten.
6. Create in a mounted folder; also use direct creation and Save As. Interrupt before
   create, after remote commit/lost response, and before local mirror initialization.
   Reload; confirm the same operation resumes, one remote file, intended content,
   and no background tab focus. Preserve newer local/remote edits or report conflict.
7. Retry with a changed payload under the same key: reject it. Corrupt a pending
   payload: retain it and report error, with no Drive upload. Pending creation is
   visible/retryable before a notebook-open link exists. Completed receipts release
   payloads and expire after seven days; unfinished requests remain recoverable.
8. Fail only the IPYNB export after the source saved. Confirm independent recovery.
   Check last attempt, last success, saved error and live eligibility separately.

Permission/quota failures need corrective action; retries cannot grant either.
Different origins/profiles are outside the same-origin coordination guarantee.
