# Drive sync recovery CUJ

## Goal

Recover failed saves, exports and notebook creations without another local edit.
Preserve content and existing conflict handling. See the
[design](../design/20260923_drive_sync_recovery.md).

## Automated coverage

- `local.test.ts`: format-correct predicates, unchanged/empty failed downloads,
  metadata-only owner discovery, legacy OPFS repair, corrupt-log isolation,
  retry reconstruction, durable creation payloads, changed-input key rejection,
  corrupt-payload preservation, receipt retention and cross-controller serialization.
- `syncWorkQueue.test.ts`: coalescing, dirty-during-processing, save interval,
  delayed backoff, no starvation, credential wake-up and explicit/background joins.
- `driveTransfer.test.ts`: idempotent creation engine, interrupted create/adoption,
  version validation, durable Save As entry point and opening only for callers.
- `driveResyncReconciler.test.ts`: startup/auth/online/timer and cleanup.
- `DriveSyncStatusTab.test.tsx`: error/attempt/success status and pending-create retry.
- `notebookData.test.ts` and `appJsGlobals.test.ts`: AppKernel creation/Save As callers.

- `ownedOperationLogs.test.ts`: lazy hashing, invalidation failure, interrupted
  initialization, original-byte preservation, write serialization and stale acknowledgements.
- `storageOwner.test.ts`: two MessagePorts, local saves during blocked sync,
  causal-view isolation, protocol mismatch, creation-error identity, credential
  deferral and backoff wake-up.
- `legacyCreationJournal.test.ts` and `driveTransfer.test.ts`: legacy identity import,
  injected worker journal replay and no remote creation after journal commit failure.
- `storage-owner-smoke.ts`: real Chromium SharedWorker, two tabs, concurrent causal
  edits, unset checksums and exact OPFS restoration after a browser restart.
- `storage-owner-production.ts`: emitted worker entry, handshake, durable creation
  and notebook decoding; catches DOM-only dependencies in the production bundle.

- `test-scenario-open-shared-drive-link.ts`: shared file/folder links, copy links
  and direct notebook creation through the worker-backed app (26 assertions).
- `test-scenario-colab-export-recovery.ts`: reconnect recovery of a saved V2 source,
  per-file HTTP 503 from the Go fake Drive service, properties-dialog retry,
  preserved source history and reuse of the same derived copy. Configure the
  endpoint on the blank fixture page before the app starts its worker.

### Run the browser checks on a devbox

Start `pnpm --dir app dev --host 127.0.0.1 --port 5193` after building packages.
Run from `app/` with `CHROMIUM_PATH` pointing to an installed Chromium:

```sh
pnpm exec tsc --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --outDir test/browser/.generated test/browser/storage-owner-smoke.ts test/browser/storage-owner-production.ts
node test/browser/.generated/storage-owner-smoke.js
```

The test creates/removes a disposable profile and writes
`test/browser/test-output/storage-owner.json`. For production, run the app build,
start `pnpm preview --host 127.0.0.1 --port 5194`, then run
`node test/browser/.generated/storage-owner-production.js`. Both tests accept
`RUNME_TEST_URL`. Neither uses production credentials or the user's browser profile.

## Live Drive acceptance (not performed by the automated suite)

Use disposable notebooks and a development build, not production failure injection.
Record the commit, origin, identity type (no tokens), status and upstream contents.

1. Save `.runme`, `.json` and `.ipynb`; inject an auth/network failure. Restore the
   dependency without an edit. Verify delayed retry and cleared error after success.
   Close/reopen a tab and repeat: unfinished state survives; a live worker keeps its retry clock. Closing every tab may end the worker and reset backoff.
2. Fail the first download with empty checksums. Verify recovery downloads the
   original content and never uploads/creates an empty notebook.
3. Remove a cached `.runme` hash in a test record. Verify discovery/status leave it unset without reading OPFS; reconciliation computes it and preserves a newer generation. Corrupt a separate disposable log;
   confirm other files and status still work and original bytes remain preserved.
4. Burst edits and periodic wake-ups. Verify one queued key, no continually pushed
   deadline, a subsequent pass for edits during upload, and the two-minute automatic
   interval. Manual retry may bypass delay but still uses the owner queue.
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
