# Recover unfinished Drive sync from durable state

## Problem

A failed sync can remain visible for days after credentials or connectivity recover.
The auth-availability transition was the only automatic reconciliation trigger.
The pending-work scan compared content hashes but excluded failed downloads when
both hashes were empty or the local content still matched its previous baseline.
A separate `.runme` migration gap backfilled a missing hash from the empty `doc`
placeholder instead of its authoritative OPFS operation log.

The intended contract remains the [level-based resync design](20260312_resyncdrive.md)
and [Drive version tracking](20260409_track_drive_versions.md): IndexedDB owns
content/baseline metadata; an in-memory queue only schedules work. Closing a tab
must not erase the evidence needed to retry.

## Decisions

### Compare hashes in the same domain

| Format | Local content/hash | Acknowledged baseline |
| --- | --- | --- |
| `.json` | Serialized IndexedDB model / `md5Checksum` | `lastRemoteChecksum` |
| `.ipynb` | Decoded model / `md5Checksum` | `ipynbPreservation.baselineNotebookChecksum` |
| `.runme` | OPFS log bytes / cached `md5Checksum` | Acknowledged local log snapshot / `lastRemoteChecksum` |

Raw IPYNB fingerprints differ from decoded-model hashes. Canonical operation
ordering can make raw Drive `.runme` bytes differ from the acknowledged local
snapshot; raw upstream identity remains in `lastUpstreamVersion.checksum`. Do not
collapse these domains or weaken existing conflict/version checks.

The scan selects Drive-backed and pending-create records from IndexedDB, then
compares their fields in application code. It does not rehash healthy content.
For a missing `.runme` hash, read OPFS and publish the hash only if a transaction's
fresh metadata still lacks it and points at the same log. Preserve a newer hash
published by a concurrent append. An unreadable log is isolated to its own sync
and status error; it cannot stop all other notebooks from being inspected.

### Failed reads are unfinished work

A retained `lastSyncError` is sufficient to retry a Drive-backed file, including
an empty first-download placeholder. Pending creation and checksum differences
continue to qualify. Conflicts remain excluded. The existing locked,
format-specific sync implementation decides whether to download, upload, merge,
or record a conflict; the reconciler never replaces content or blesses a baseline.

### Reconcile while connected

Start a pass when the store has Drive auth, on browser-online events, and every
two minutes. Coalesce wake-ups while a pass is active. Two workers limit each
pass's source-sync concurrency. Cleanup and loss of auth stop new scheduling;
already-running operations retain their existing completion/locking behavior.

Persist optional `lastSyncAttemptedAt`, `syncFailureCount`, and `nextSyncAttemptAt`
fields on each file. No IndexedDB schema/index migration is needed. A failed
attempt waits 2, 4, 8, 16, then 30 minutes; subsequent delays stay at 30 minutes.
This caps spacing, not the number of retries. Background startup, online and timer
passes respect the deadline. Manual sync and an observed auth recovery may bypass
it. Check the deadline again under the cross-tab lock, since another tab may have
failed while this caller waited. Success clears the failure and deadline.

New local edits keep their existing debounce scheduling. Failed derived IPYNB
exports retain their separate error/recovery path: a clean source is not proof
that its derived copy was exported. Reconciliation does not reset source debounce
timers on every tick.

### Explain attempts separately from successful sync

Drive Status displays the stored error, last attempt, and retry eligibility.
`lastSynced` still means success. Eligibility depends on an open app, credentials,
connectivity and scheduling; it is not a promise of execution at that exact time.
Old records have no attempt history, so their last successful sync date cannot
establish when they were last tried.

## Limits

Retries cannot fix missing permissions or service-account storage quota. Conflicts
still require explicit resolution. This change does not poll clean files for
remote edits, make OPFS/IndexedDB atomic, or detect every nonempty stale cached
hash after a crash between their writes. Existing manual/debounced/export work
can coexist with the two-worker reconciliation pass. Derived exports retain their
existing retry scheduling rather than using the new source retry deadline.

## Verification

`local.test.ts` covers all three checksum domains, empty failed downloads,
OPFS backfill, concurrent checksum publication, corrupt-log isolation, recovery
through the actual sync path, retry deadlines after store recreation, cross-tab
failure timing, and continuing other files after one fails.
`driveResyncReconciler.test.ts` covers startup, timer/online wake-ups, offline
suspension, auth-recovery bypass, cleanup, scan errors and coalescing.
`DriveSyncStatusTab.test.tsx` distinguishes attempts from successful sync.

See the [recovery CUJ](../CUJs/drive-sync-recovery.md) for manual acceptance steps.
