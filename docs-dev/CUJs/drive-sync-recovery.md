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

## Local-first notebook opening

Opening a cached notebook must not wait for Drive, including an already running
sync for a different notebook. A `.runme` operation-log reference identifies local
content even though its IndexedDB `doc` is empty. Cached JSON/IPYNB models and
new empty notebooks awaiting upstream creation also open locally. An old or missing successful-sync timestamp schedules background
reconciliation; it does not make available content an initial-download miss.
Only an uncached notebook waits for upstream content, and a failed first download
must surface the error instead of showing an empty notebook.

Creating a file in a mounted Drive folder already persists it locally and starts
Drive creation asynchronously. Its subsequent open must honor that contract:
users can edit, save, close and reopen while `pending-upstream-create` remains.
The existing operation ID and retry state own eventual upstream creation.

Automated coverage:

- `local.test.ts`, `LocalNotebooks local-first open`: blocked shared queue, cached
  OPFS and legacy models, offline pending creation/edit/reopen, and failed first
  downloads even when metadata has a recent successful-sync timestamp.
- The stale operation-log merge test opens local content first, then explicitly
  reconciles and verifies convergence without rewriting the loaded snapshot.
- `storage-owner-smoke.ts` stalls credential delivery in an isolated Chromium
  profile so no real Drive request is sent. While that worker reconciliation is
  pending, a second tab opens cached OPFS content and creates/edits/reopens a new
  notebook in a test Drive folder. Each local open has a two-second deadline,
  shorter than credential or RPC timeouts. Browser restart preserves exact bytes.

Manual acceptance: with a development build and disposable notebooks, take Drive
credentials/connectivity offline, reopen an existing cached notebook, and create a
new file in an already mounted Drive folder. Edit and reopen both. Restore Drive
and verify eventual convergence and a single upstream identity. A notebook never
downloaded locally must still report the unavailable dependency. Background
reconciliation does not replace an editor's mounted causal view; explicit refresh
continues to read the local log without upstream I/O.

The editor and its save adapter must start from the same captured log. A sync or
another tab can append between the initial load and adapter creation. Open and
local refresh therefore render the adapter's `initialNotebook`, captured with its
causal heads, instead of combining separately read snapshots. Test an append in
that interval, then edit/save/reopen and verify that the unseen cells survive.
Mutating the returned model must not mutate the adapter's baseline.

The `createView` worker response now carries that snapshot, so the storage owner
protocol is version 2. Mixed-version clients must fail with the existing reload
message. After deployment, close/reopen all Runme tabs on that origin if an old
worker remains alive; do not clear browser storage.

## Lazy Drive discovery and queue monitoring

Mirroring a large Drive folder must not enqueue metadata-only files that have
never been downloaded. In worker mode, an empty local checksum indicates source
work only with an OPFS operation-log reference or a cached legacy model. Pending
creation and failed first-download recovery still retry. A missing referenced log
must report its read error rather than being skipped or replaced.

The Drive status page shows owner-side queue depth (peak waiting keys per ten
seconds, up to one hour) and eligible-to-dequeue wait (histogram of attempts since
owner startup). Waiting includes delayed work but excludes the active attempt;
wait excludes debounce, retry delay and post-dequeue processing/locks. Retries count
separately. Current eligible/delayed/active counts, oldest eligible wait and active
attempt duration distinguish stalled processing from slow throughput. Metrics are
shared across tabs, collected with the view closed, and reset on owner restart.
The diagnostics RPC uses storage owner protocol version 3.

Automated coverage: `local.test.ts` mirrors 1,000 placeholders without enqueueing
or OPFS reads and preserves legitimate pending cases; `syncWorkQueue.test.ts`
checks depth, eligible wait/backoff, deduplication, bounded history and reset;
`storageOwner.test.ts` reads metrics from two MessagePorts;
`DriveQueueMonitor.test.tsx` covers both charts, polling and unavailable state.

Manual acceptance: mount a large disposable folder without opening its notebooks;
confirm no source backlog from untouched entries. Edit a few cached notebooks and
create one offline. Open Drive status, then close/reopen only that view: the charts
retain owner history. Restore connectivity and observe the waiting count drain.
Check that the histogram excludes scheduled delays and the current oldest-wait
summary grows behind a deliberately stalled attempt. Close all same-origin tabs
and reopen: history restarts without deleting pending notebook work.

Untouched placeholders are labeled `not-downloaded` and can be filtered in the
status table. “Sync Required” must exclude them, even when another row needs sync.
Explicit opening still downloads them. If the worker stops responding, diagnostics
show an unavailable message after ten seconds; the charts identify the time of
the last received snapshot instead of implying current health.

## Status refresh backpressure

Storage notifications must not start overlapping status scans. Each mounted
status view coalesces notifications for 100 ms and retains only one pending
refresh during an active request. Closing the document cancels scheduled work
and ignores the active result. The owner shares an in-flight status scan across
ports, releasing it on either success or failure; subsequent reads remain fresh.
Each page reads at most 50 records, enumerating at most 51 keys for lookahead,
and processes one file or creation request at a time. Previous/Next navigation
uses primary-key cursors. Filters, sorting and Sync Required apply to the current
page, as stated in the UI. It must not retain arrays of all cached notebook or pending-create payloads,
or re-read a file just to compute its status. This bounds retained payloads by
individual record size, not by the sum of the database's notebook contents.

Automated coverage: `DriveSyncStatusTab.test.tsx` holds a read open while sending
100 triplets of update events, checks one active request and one follow-up, and
checks close-during-refresh. `storageOwner.test.ts` uses two MessagePorts to check
one underlying scan, shared failure, and a successful subsequent read.
`local.test.ts` rejects bulk payload reads and checks a single read per file,
including deletion between key enumeration and retrieval.

`tableScan.test.ts` covers the shared row/byte caps, overflow cursors, skipped
records, oversized projections, early stream termination and a 50 MiB legacy
body. `boundedStorageReads.test.js` verifies the storage lint rule and checks
production sources for direct bulk-read bypasses. All status pages go through
`readTablePage()`; background and migration enumeration goes through `scanTable()`.

Manual acceptance: open the status document in two same-origin tabs while Drive
sync is producing updates. Profile the storage SharedWorker in Chrome DevTools.
Compare worker allocation sampling and heap snapshots with the status document
closed, open, and closed again. Close the document itself: switching to another
notebook leaves tab content mounted. Check that status scans do not overlap,
rows converge after updates stop, and pending reads do not accumulate. Repeat
with a large cached legacy notebook and pending creation payloads. This verifies
memory behavior in addition to the deterministic concurrency tests; those tests
alone do not prove that a particular native out-of-memory crash is resolved.

## Metadata-only IndexedDB and OPFS payload migration

Schema 9 stores notebook content references in IndexedDB. JSON/IPYNB cached
models, pending creation bodies, pending `.runme` initialization, and legacy
inline conflict bodies move into immutable OPFS files. Existing `.runme` logs,
IPYNB preservation shadows, conflicts, revisions, and linked media retain their
existing OPFS storage. Read the [storage design](../design/20260924_bounded_storage_payloads.md)
for migration ordering, cleanup, and the bulk-read audit.

`storage-payloads-smoke.ts` creates a disposable schema-8 database in an isolated
browser profile with 67 records, including a 50 MiB cached notebook. It verifies
50 + 17 status pages, background migration, exact-byte preservation, JSON/IPYNB
edit/save, transactional `.runme` initialization, browser restart, and cleanup of
obsolete generations. No production credentials or Drive requests are used.
Artifacts are written to `app/test/browser/test-output/storage-payloads.json`.

From `app/`, compile and run with an installed test browser and Vite:

```sh
pnpm exec tsc --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --outDir test/browser/.generated test/browser/storage-payloads-smoke.ts
CHROMIUM_PATH='/path/to/test/chrome' RUNME_TEST_URL=http://127.0.0.1:5193 node test/browser/.generated/storage-payloads-smoke.js
```

`filePayloads.test.ts` covers failed durable close, Unicode integrity, corruption,
and cleanup while reads/writes are in flight. `local.test.ts` covers migration
write/commit failures, concurrent edits, retry, and missing payload preservation.
After rollout, close all Runme tabs and worker inspectors before reopening so the
new owner and schema are used. Do not clear site data. Repeat the heap comparison
on the affected profile; isolated fixtures cannot establish that every source of
memory growth in a deployed session has been fixed.

### Payload recovery and save ordering regressions

- Hold an earlier JSON save's filesystem write open, then submit a newer save.
  The later save must remain the final content after both complete. A rejected
  write must not prevent the next queued save from succeeding.
- With a notebook already recovered in memory, make its old payload unreadable.
  Saving the recovered content and reopening must work without reading the old
  payload. Metadata/status and upstream-revision access must remain available.
- Leave an unreadable pending initialization reference beside a healthy `.runme`
  journal. Open, edit, save, and reopen the journal; retain the pending reference
  for diagnosis while normal edits continue to work.
- Retry a completed Drive creation with the same key/input while OPFS writes
  fail. Return the durable receipt without another payload write or Drive call.
