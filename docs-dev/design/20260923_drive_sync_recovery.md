# Recover unfinished Drive sync from durable state

## Problem and objective

A failed save must recover when credentials or connectivity return, without
requiring another edit. The old scan excluded failed downloads when hashes
matched or were empty, and ran only on an auth transition. Missing `.runme`
checksums were repaired from the empty IndexedDB `doc` placeholder instead of
OPFS. Direct creation needed a replayable request before any Drive mutation.

The contract follows [level-based resync](20260312_resyncdrive.md) and
[Drive version tracking](20260409_track_drive_versions.md): durable content and
recovery state determine unfinished work. The queue only schedules it.

## Content and checksum domains

| Format | Local content/hash | Comparable acknowledged baseline |
| --- | --- | --- |
| `.json` | IndexedDB serialized model / `md5Checksum` | `lastRemoteChecksum` |
| `.ipynb` | Decoded model / `md5Checksum` | `ipynbPreservation.baselineNotebookChecksum` |
| `.runme` | OPFS operation log / cached `md5Checksum` | Acknowledged local log snapshot / `lastRemoteChecksum` |

Raw IPYNB fingerprints differ from decoded hashes. Canonical operation ordering
can make raw Drive `.runme` bytes differ from the acknowledged local snapshot;
raw upstream identity remains in `lastUpstreamVersion.checksum`. Do not collapse
these domains or weaken conflict/version checks.

For example, independent operations may appear locally as `[B, A]` and upstream
in canonical order `[A, B]`: the same operations have different byte hashes.
`lastRemoteChecksum` remembers the local snapshot acknowledged upstream;
`lastUpstreamVersion.checksum` identifies the actual upstream bytes/version.
Compare current local bytes with the acknowledged local snapshot for local edits.

The IndexedDB-backed scan compares fields in application code. Conflicts are
excluded. Pending creation qualifies before checksum comparison. A retained
`lastSyncError` qualifies regardless of checksum equality: matching or empty
hashes do not prove the latest download succeeded. A failed first download must
retry reading, never upload its empty placeholder.

Healthy records need no content read. Repair a missing `.runme` checksum from
OPFS, then reread metadata transactionally before publishing it; preserve a newer
checksum or changed log reference. An unreadable log is a per-file error and
cannot break the whole scan or status table.

### Review requirement: invalidate before changing OPFS

An interrupted save can leave newer OPFS bytes with an old cached checksum. If
that hash equals the acknowledged baseline, a scan can incorrectly call the file
clean. Clear `md5Checksum` **before** the OPFS write, not afterward. Empty means
unknown and requiring recomputation; it does not mean an empty notebook or prove
that content differs. Keep `lastRemoteChecksum` as the acknowledged baseline.

Use one per-notebook, same-origin consistency lock for writers and checksum repair:

1. Acquire the lock; commit and await IndexedDB `md5Checksum = ""`.
2. If invalidation fails, abort before writing OPFS.
3. Write/append OPFS and await durable close.
4. Publish the resulting snapshot's checksum and log-reference metadata while
   still holding the lock, then release it. If publication fails, leave the hash
   unknown. Never restore the old cached value on failure.
5. Checksum repair acquires the same lock, rereads the record, reads/hashes OPFS
   only if still unknown, and publishes before releasing it.

Without that shared lock, repair could hash the old OPFS bytes after invalidation
but before the writer commits. A crash after the OPFS write would then leave the
old hash again. A physical OPFS-only lock is insufficient. Older asynchronous
save/sync callbacks must also not publish captured hashes outside this protocol.
All mutation paths must participate: edits, executions, annotations/revisions,
imports/replacements, upgrades and sync merges. First initialization must retain
a discoverable creation/download record and intended log identity before creating
bytes; missing references must not make that operation look clean.

A crash before invalidation leaves untouched bytes; after invalidation it leaves
an unknown checksum. On restart, recompute from whichever bytes actually committed.
This may do an extra check when the OPFS write never happened, which is safe.
Unreadable/corrupt bytes remain preserved with a per-file error. Never hash the
empty IndexedDB `doc` placeholder. This protocol prevents future stale caches;
a one-time integrity sweep is still needed to find nonempty stale hashes left by
older code. It does not make the two stores atomic.

**Implementation status:** code at `1f855a6` implements missing-hash repair and its
fresh-metadata guard, not this complete writer/repair protocol. This review
requirement must be implemented across every mutation path before claiming the
crash window is closed.

Required tests interrupt before/after invalidation and after OPFS close, recreate
the controller, race two writers with a repairing reader, and delay an older
metadata callback. Cover initialization, replacement, merge, edits and annotations;
retain corruption isolation and verify acknowledgement only covers uploaded bytes.

## Keyed delaying queue

`SyncWorkQueue` follows the dirty/processing and delayed-retry pattern of
[Kubernetes client-go workqueue](https://github.com/kubernetes/client-go/tree/master/util/workqueue).
It is a TypeScript implementation, not a dependency on the Go package.

- Persist an edit/request, then add `source:<uri>`, `markdown:<uri>`,
  `ipynb:<uri>` or `create:<operationId>`, even without Drive auth.
- Local saves, periodic scans, manual sync, creation recovery and exports share
  one queue per controller. One item runs at a time; delayed keys do not block
  unrelated ready keys. Repeated adds coalesce without extending the deadline.
  An add during processing requests another pass.
- Attempts reread stored state. Source scans skip records already made clean.
  Creation retains an immutable snapshot because Save As captures an intent.
- Failures retain an error and requeue after 2, 4, 8, 16, then at most 30 minutes.
  Success forgets the failure count. **Retry counts and deadlines are in memory.**
  A new controller scans durable state and starts backoff afresh.
- Missing auth/offline defers two minutes without a Drive request or increased
  failure count. Auth recovery wakes delayed keys. Startup/auth/online and
  two-minute scans reconstruct work; auth gates I/O, not local writes/enqueueing.
- Automatic local saves initially wait 20 seconds. Further automatic attempts
  have a two-minute minimum per key. Source/IPYNB jobs also check persisted
  success times under the origin lock, preventing another tab immediately
  repeating a successful background save. Markdown's interval is queue-local.
- Manual sync bypasses delay through the same queue and waits for one attempt.
  It joins an active attempt for the same key. Errors reach the explicit caller
  while the item remains queued for recovery.

This is a per-key save interval, not a global requests-per-second quota. Each
attempt may make several Drive calls. Backoff can reset on reload or another
tab; durable failure timing is intentionally not part of correctness.

IPYNB exports retain separate error/recovery state. A Drive-backed operation-log
notebook with an export error, no conflict and no unconfirmed export claim is
queued even if its source is clean. A successful source save is not proof of a
successful export.

## Cross-tab coordination and worker decision

Queued source sync, export and direct-create attempts acquire the same
origin-scoped Web Lock, then retain existing per-file locks. Multiple tab queues
can exist, but only one such attempt runs at a time within the origin/profile.
The in-process fallback coordinates only one JavaScript context. Different
origins, profiles and devices do not share the lock. Timers are disposable;
context exit releases locks and a successor reconstructs work from storage.

A DedicatedWorker belongs to one tab. A SharedWorker could centralize scheduling
for multiple same-origin tabs and move checksum/serialization work off the UI
thread, **if all entry points use its message protocol**. Async network waiting
already yields; CPU work around it can still block the current main thread.

The [multi-tab design](20260520_multi_tab_support.md) chose Web Locks as ownership
authority and considered SharedWorker unnecessary for that ownership contract;
a service worker is not an always-running owner. The
[Codex adapter design](20260310_codexapp.md) kept its first implementation on the
main thread because async I/O did not justify auth/messaging/lifecycle complexity.
That rationale concerns the adapter, not a Drive-specific worker decision.

This PR retains the current execution context. A SharedWorker migration needs a
storage/auth message boundary, reconnect/teardown behavior and browser support
validation. It would not remove durable recovery after all tabs close, remote
conflicts, or OPFS/IndexedDB consistency requirements. This PR does not claim to
move expensive save processing off the UI thread.

## Creation and Save As

Mounted-folder creation retains its local record, parent marker and operation ID;
`.runme` content comes from OPFS. Direct creation and Save As persist the complete
serialized notebook, fingerprint, destination folder, name and operation ID in
IndexedDB `driveCreates` (schema version 7) **before Drive I/O**. Payload and
request commit together without a visible staging notebook or an additional
OPFS/IndexedDB two-write gap. Existing `.runme` notebooks still use OPFS.

Each intentional Save As gets a new operation ID. Retries reuse it. Same-key
input changes fail. Recovery verifies the payload fingerprint and parses it;
corrupt content remains stored with an error and is never replaced by an empty
upload. The request pins a folder and operation identity, not a Google account;
current credentials must have access to the destination.

The common queue invokes the existing idempotent creation engine, retaining its
reserved/known remote ID and operation-marker journal. Interrupted create,
verification or mirror initialization resumes the same remote operation.
Ambiguous create outcomes follow that engine's lookup rules rather than blindly
creating again. Adoption must preserve newer remote edits.

Mark complete only after remote verification/local initialization. Release the
payload, retain a compact result/fingerprint receipt, and expire completed
receipts after seven days. Unfinished requests never expire with session cleanup.
Legacy localStorage-only attempts lacking payload still need their original
caller to retry. Local receipt retention is not permanent cross-profile
idempotency. Background recovery never opens/focuses a tab; an explicit caller
can open the completed notebook.

Drive Status includes pending creation before a mirror exists: last error and
live retry eligibility, with retry through **Sync Required** but no broken
notebook-open link. Existing source rows display saved errors and last attempt
separately from last successful sync. Eligibility depends on auth, connectivity,
other work and locks; it is not an exact execution promise.

## Validation and limits

Tests cover unchanged/empty failed downloads, format-specific hashes, OPFS repair
and corruption isolation, coalescing/delays/backoff, edits during processing,
manual joins, controller restart, direct-create payload retention/key conflicts,
receipt cleanup, creation/export/source serialization across controllers, status
and AppKernel callers. Existing creation-engine tests retain interrupted-create
and remote-adoption coverage. See the [CUJ](../CUJs/drive-sync-recovery.md) for live
acceptance steps; automated transport mocks are not live Drive failure injection.

Retries cannot fix permissions/quota or auto-resolve conflicts. Clean remote-file
polling, nonempty stale checksum repair, SharedWorker migration and the separate
Logs-view memory investigation are outside this PR.
