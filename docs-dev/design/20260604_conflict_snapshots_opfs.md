# Conflict Snapshot Storage in OPFS

Date: 2026-06-04

Builds on:

- `docs-dev/design/20260530_notebook_conflict_resolution.md`
- `docs-dev/design/20260409_track_drive_versions.md`
- `docs-dev/design/20260409_data_migrations.md`

Related:

- Issue: `runmedev/web#249`
- PR: `runmedev/web#251`

## Summary

Conflict management should store large upstream conflict snapshots in OPFS, not
inline on the hot IndexedDB `files` record.

IndexedDB remains the source of truth for notebook identity, sync status, and
conflict metadata. OPFS stores only the large serialized upstream notebook
document needed to open a conflict diff.

This changes the conflict data model from:

```text
IndexedDB files record
  doc: local notebook JSON
  conflict.upstreamDoc: upstream notebook JSON
```

to:

```text
IndexedDB files record
  doc: local notebook JSON
  conflict.upstreamDocRef: OPFS pointer + size/checksum metadata

OPFS
  runme/conflicts/<encoded local URI>/upstream.json
```

The user-facing conflict flow stays the same: conflict detection stops sync,
the notebook tab shows `conflicted`, clicking the sync indicator opens the
upstream-vs-local diff, and **Save local version** resolves the conflict by
writing local content back to the original upstream file.

## Problem

The original conflict-resolution design stored `conflict.upstreamDoc` inline on
`LocalFileRecord` in IndexedDB. That was simple and kept the upstream snapshot
available offline, but it made the `files` record carry two potentially large
notebook payloads:

- `doc`: current local notebook JSON
- `conflict.upstreamDoc`: upstream notebook JSON captured at conflict detection

That record is on a hot path:

- `LocalNotebooks.load(uri)` reads the full `files` record before parsing
  `record.doc`.
- `LocalNotebooks.getSyncState(uri)` reads the full record to render the sync
  indicator.
- `NotebookSyncIndicator` stores the returned sync state in React state.

In the incident that motivated this change, the local notebook document was
about 11 MB and `conflict.upstreamDoc` was about 11.8 MB. Opening the notebook
could crash Chrome before the user clicked the sync indicator. Exporting the
notebook JSON and re-uploading it to Drive opened successfully, which showed the
notebook JSON itself was not the only trigger. Clearing only the stale
`record.conflict` snapshot stopped the crash.

The crash did not require `openNotebookConflictDiff()`. Passive page load was
enough because the app moved the large inline conflict snapshot from IndexedDB
into JavaScript and then into UI state.

## Goals

- Keep passive notebook load and passive sync-state reads lightweight.
- Preserve stable conflict diffs when upstream changes after detection.
- Preserve offline/local conflict review when the snapshot is already local.
- Keep IndexedDB as the queryable metadata/index layer.
- Store large conflict document payloads in a storage surface designed for file
  blobs.
- Support legacy inline `conflict.upstreamDoc` records without crashing on
  passive sync-state reads.

## Non-Goals

- Moving the whole notebook store from IndexedDB to OPFS.
- Changing conflict-resolution semantics or user-facing labels.
- Adding cell-level conflict resolution.
- Adding a multi-version history system.
- Automatically garbage collecting all historical OPFS data in this first
  change.

## Decision

Use a two-layer model:

1. IndexedDB stores conflict metadata and an optional OPFS reference.
2. OPFS stores the serialized upstream conflict document.

`LocalFileRecord.conflict` remains the durable marker that the notebook is in a
conflicted state. It must be small enough to safely return from
`getSyncState()` and hold in React state.

Illustrative types:

```ts
export interface ConflictDocumentRef {
  storage: 'opfs'
  path: string
  sizeBytes: number
  checksum: string
}

export interface NotebookConflictState {
  detectedAt: string
  upstreamChecksum: string
  upstreamVersion?: UpstreamVersion
  upstreamDocRef?: ConflictDocumentRef

  // Legacy only. New records should not set this.
  upstreamDoc?: string

  localChecksumAtDetection: string
}

export interface NotebookConflictSummary {
  detectedAt: string
  upstreamChecksum: string
  upstreamVersion?: UpstreamVersion
  upstreamDocRef?: ConflictDocumentRef
  upstreamDocSizeBytes?: number
  localChecksumAtDetection: string
}
```

`NotebookSyncState` should expose only `NotebookConflictSummary`, not the full
`NotebookConflictState`.

## Storage Layout

Conflict snapshot files are stored under the origin private file system:

```text
runme/
  conflicts/
    <encodeURIComponent(localUri)>/
      upstream.json
```

Example:

```text
runme/conflicts/local%3A%2F%2Ffile%2F5358eab1-1eb5-4f84-9693-d899baf3e35f/upstream.json
```

The OPFS path is an implementation detail. IndexedDB should store enough
metadata to read and validate the snapshot:

- `path`
- `sizeBytes`
- `checksum`
- `storage: "opfs"`

## Write Path

When Drive sync detects a conflict:

1. Load the current upstream notebook from Drive.
2. Serialize the upstream notebook to JSON.
3. Write the serialized upstream document to OPFS.
4. Store conflict metadata plus `upstreamDocRef` on the `files` record.
5. Leave `remoteId`, `doc`, and local edits unchanged.
6. Notify sync listeners so the tab indicator shows `conflicted`.

If OPFS write fails, sync should fail visibly instead of uploading, downloading,
or silently creating a copy. The safe fallback is `lastSyncError`, not inline
storage of a large payload on the hot record.

## Read Path

Passive reads must not load the conflict document.

`getSyncState(localUri)` should:

1. Read the local `files` record.
2. Return `status: "conflicted"` if `record.conflict` exists.
3. Include conflict summary metadata only.
4. Never include `conflict.upstreamDoc`.

Opening the conflict diff is the explicit read path:

1. Read the local `files` record.
2. Resolve the upstream snapshot:
   - if `upstreamDocRef` exists, read OPFS
   - if legacy `upstreamDoc` exists, migrate it to OPFS and update the record
   - otherwise show a recoverable missing-snapshot error
3. Parse upstream and local notebooks.
4. Compute and display the notebook diff.

## Legacy Inline Records

Existing profiles can already have inline `conflict.upstreamDoc` values. The
new code must handle them safely.

Passive migration is not required and should be avoided if it would read or
clone the large document just to render the conflict indicator.

Legacy behavior:

- `getSyncState()` returns a lightweight summary.
- If `upstreamDoc` is inline, the summary may report
  `upstreamDocSizeBytes`, but it must not return the document string.
- `getConflictUpstreamDoc(localUri)` migrates the legacy inline document to
  OPFS on demand when the user explicitly opens the diff.
- After successful migration, the IndexedDB record should contain
  `upstreamDocRef` and no inline `upstreamDoc`.

## Resolution And Cleanup

When the user chooses **Save local version**:

1. Verify the upstream version has not changed since the conflict snapshot, or
   require force/confirmation if it has changed.
2. Write the local `doc` to the original upstream file.
3. Refresh upstream version metadata.
4. Clear `record.conflict`.
5. Delete the referenced OPFS conflict snapshot on a best-effort basis.

OPFS deletion failure should not block successful conflict resolution. It should
be logged as a cleanup warning.

Future cleanup work should garbage collect OPFS conflict directories whose
local file record no longer exists or no longer points at that conflict ref.

## Failure Handling

### OPFS unavailable while recording conflict

Set `lastSyncError` and leave local content untouched. Do not silently fall back
to inline `upstreamDoc` for large snapshots, because that reintroduces the
crash class this design removes.

### OPFS snapshot missing while opening diff

Show an error in the conflict diff path. The user can refresh the conflict
snapshot from Drive if they still have access, or resolve from local after an
explicit confirmation path.

### OPFS snapshot checksum mismatch

Treat this as a corrupt local snapshot. Do not compute a diff against it. A
future implementation can add automatic refresh from Drive when the upstream
revision still matches.

### Legacy inline snapshot cannot be migrated

Return an actionable error from `openNotebookConflictDiff()`. Do not put the
large inline document into React sync state.

## Test Plan

Storage tests should cover:

- Recording a Drive conflict writes the upstream document through the conflict
  document storage abstraction.
- New `record.conflict` contains `upstreamDocRef` and no `upstreamDoc`.
- `getConflictUpstreamDoc(localUri)` reads the OPFS-backed document.
- `getSyncState(localUri)` returns `conflicted` without exposing
  `upstreamDoc`.
- Legacy inline `upstreamDoc` is migrated to OPFS on explicit diff open.
- Resolving a conflict clears IndexedDB conflict metadata and best-effort
  deletes the OPFS document.

UI/runtime tests should cover:

- The sync indicator can render a conflicted notebook without receiving a large
  upstream document.
- Clicking the conflict indicator still opens the diff.
- Refreshing a conflict diff writes the refreshed upstream snapshot to OPFS.

Manual/browser regression:

1. Seed IndexedDB with a large conflicted local record.
2. Open the notebook.
3. Verify the page remains alive and shows the conflicted indicator.
4. Click the indicator and verify the diff opens or fails recoverably.

## Tradeoffs

OPFS is still origin/profile-local. It is not a sync mechanism and does not make
conflict snapshots portable across profiles.

The split also introduces a small consistency risk: IndexedDB metadata can point
at an OPFS file that no longer exists. The conflict diff path must handle this
as recoverable local-storage corruption.

The benefit is that hot IndexedDB reads stay bounded and predictable. Large
conflict payloads are loaded only when the user explicitly asks to review the
conflict.

## Follow-Up Work

- Add OPFS garbage collection for orphaned conflict snapshots.
- Add snapshot checksum verification on OPFS reads.
- Add a "refresh upstream snapshot" action for missing or corrupt snapshots.
- Add a size threshold that shows a lightweight conflict review flow when diff
  computation itself would be too expensive.
- Consider moving other cold large payloads out of hot IndexedDB records if
  similar crash or latency issues appear.
