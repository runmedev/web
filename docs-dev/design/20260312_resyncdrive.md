# 20260312: Resync Drive After Auth/Connectivity Loss

## Problem

When Google Drive sync is unavailable (expired credential, offline, transient API failure), users can still edit notebooks locally. Those edits are persisted in IndexedDB, but after Drive auth is restored we do not automatically replay all pending changes.

Current impact:

1. User opens Drive-backed notebook.
2. Drive sync stops working.
3. User edits and closes notebook.
4. User re-authenticates Drive.

At step 4, edits are not automatically pushed unless another sync trigger happens (new save/edit, manual sync, or a later load path).

## Goal

After Drive connectivity/auth recovers, automatically resync all locally modified Drive-backed notebooks without requiring user action.

## Non-goals

- Reworking conflict resolution semantics.
- Syncing local-only notebooks (no `remoteId`) to Drive by default.
- Building a server-side sync queue.

## Can this be level-based?

Yes. A level-based model is the right fit.

Instead of relying on one-shot edge triggers ("a save happened"), compute and reconcile the current desired state:

- Desired state: every Drive-backed local record whose local content differs from last known remote baseline is eventually synced.
- Reconciler can run repeatedly (on auth restore, on online event, at startup, periodic timer) and converge.

This avoids dropped events and naturally recovers from auth/network outages.

## IndexedDB Query Strategy

We will keep this level-based without adding `needsSync`.

Schema update:

- Add `md5Checksum` to each local file record.
- Update `md5Checksum` whenever `doc` is saved.

Dirty query:

1. Query drive-backed files:
   - `files.where("remoteId").notEqual("").toArray()`
2. Dirty predicate:
   - `record.md5Checksum !== (record.lastRemoteChecksum ?? "")`

Migration behavior:

- Existing records may not have `md5Checksum`.
- During migration, set missing `md5Checksum` to `""` (cheap migration).
- In reconciler code, if checksum is missing/empty and `doc` exists, compute `md5(doc)` once and backfill the record.

Result:

- We avoid re-hashing every file on every reconciliation cycle.
- We avoid introducing a second dirty-state field (`needsSync`) that can drift.

## Proposed Design

1. Persist `md5Checksum` on every local save for Drive-backed file.
2. Add a `DriveResyncReconciler` that runs when:
   - Drive auth transitions to available (`isDriveSyncing` false -> true).
   - Browser fires `online`.
   - App startup (after store init).
   - Optional periodic tick (e.g. every 2-5 minutes) while auth is available.
3. Reconciler queries drive-backed files and enqueues those where
   `md5Checksum !== lastRemoteChecksum`.
   - If `md5Checksum` is missing/empty for migrated records, compute from `doc` and backfill first.
4. Enqueue sync with bounded concurrency (e.g. 2-4).
5. On success: update `lastRemoteChecksum`, `lastSynced` (and keep `md5Checksum` in sync with local `doc`).
6. On retryable failure (auth/network/5xx): no state flip required; file remains dirty by checksum comparison.
7. On non-retryable failure (404 removed remote): keep record dirty and surface user-visible state/action.

## Interaction with Existing Sync

Current debounced per-file sync stays in place. The reconciler is additive and handles missed/deferred work.

Conflict handling remains in `syncFile` / `handleConflict`.

## Rollout Plan

1. Add `md5Checksum` field + migration.
2. Update local save path to write `md5Checksum`.
3. Add reconciler and lazy backfill path for missing checksums.
4. Validate behavior with auth-loss scenario.

## Test Plan

1. Edit Drive-backed file while auth unavailable.
2. Verify local persisted edit.
3. Restore auth.
4. Verify reconciler uploads without additional user edits.
5. Verify conflict path still preserves data.
6. Verify retries persist across reload.

## Open Questions

- Should reconciler run immediately on auth restore or with short jitter?
- Max concurrent uploads to avoid Drive throttling?
- Do we want a "pending sync count" in UI?
