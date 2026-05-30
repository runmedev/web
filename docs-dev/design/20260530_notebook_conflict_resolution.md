# Notebook Conflict Resolution

Date: 2026-05-30

Builds on:

- `docs-dev/design/20260409_refactor_notebooks.md`
- `docs-dev/design/20260409_track_drive_versions.md`
- `docs-dev/design/20260522_notebook_diffs.md`
- `docs-dev/design/20260526_workspace_document_tabs.md`

## Summary

When a local notebook and its upstream file both changed from the last synced
baseline, stop automatic sync and show an explicit conflict state.

V0 should not create a timestamped Google Drive copy and silently repoint the
local notebook at it. That avoids data loss, but it changes the user's backing
file without consent and makes the resolution path hard to understand.

V0 should instead:

1. Detect the conflict during sync.
2. Preserve the local notebook and the upstream snapshot that caused the
   conflict.
3. Mark the notebook as `conflicted`.
4. Surface the conflict in the notebook tab sync indicator.
5. Let the user open a notebook-aware diff tab comparing upstream and local.
6. Let the user explicitly save the current local notebook back to the original
   upstream file.

Cell-level resolution tools are follow-up work. In V0, users resolve by editing
the local notebook manually, reviewing the diff, and then choosing **Save local
version**.

## Problem

The local mirror protects editing latency and offline recovery, but it creates a
real conflict case:

```text
last synced upstream checksum = A
current local checksum        = B
current upstream checksum     = C

B != A and C != A
```

The current Drive sync path detects this condition in
`LocalNotebooks.syncFileInner(...)`. It resolves the conflict by calling
`handleConflict(...)`, which creates a new timestamped Drive file containing the
local version and updates `LocalFileRecord.remoteId` to point at that new file.

That behavior has two problems:

- The user opened and edited one Drive file, but the app silently changes the
  notebook's upstream file.
- The user does not get a review step before choosing whether local or upstream
  content should win.

The app can now render notebook diffs, so the safer V0 is to stop sync, show the
conflict, and make overwrite an explicit user action.

## Goals

- Preserve both local and upstream content when a conflict is detected.
- Keep the notebook attached to the original upstream file until the user
  chooses otherwise.
- Show a clear conflict signal in the notebook tab.
- Make the diff reachable from the conflict signal.
- Support an explicit **Save local version** action that overwrites the original
  upstream file with the current local notebook.
- Keep V0 two-way: upstream snapshot versus current local notebook.
- Reuse the existing notebook diff model and workspace diff tab.

## Non-Goals

- Cell-level accept/reject controls in V0.
- Automatic merge in V0.
- Three-way merge in V0.
- Git conflict UI.
- Replacing Google Drive revision history with a Runme-owned version history
  system.
- Automatically saving a conflict copy to a new Drive file.

## Current Implementation Context

The app-facing persistence path is still:

```text
NotebookData / editor tabs
  -> local://file/<id>
  -> LocalNotebooks / IndexedDB
  -> optional upstream from LocalFileRecord.remoteId
```

Relevant current code:

- `app/src/storage/local.ts` owns the local mirror, sync state, and Drive sync.
- `app/src/storage/drive.ts` reads Drive checksums, revision metadata, and
  revision contents.
- `app/src/components/Actions/Actions.tsx` renders the notebook tab sync
  indicator.
- `app/src/lib/notebookDiff/*` computes and registers notebook diff documents.
- `app/src/components/NotebookDiff/NotebookDiffView.tsx` renders the diff tab.

`LocalFileRecord` already stores:

- `doc`: serialized local notebook,
- `md5Checksum`: checksum of `doc`,
- `remoteId`: upstream URI,
- `lastRemoteChecksum`: last synced upstream checksum,
- `lastUpstreamVersion`: last synced upstream checksum/revision metadata,
- `lastSyncError`: last sync failure.

`NotebookSyncStatus` currently has:

```ts
type NotebookSyncStatus =
  | 'local-only'
  | 'synced'
  | 'pending'
  | 'pending-upstream-create'
  | 'syncing'
  | 'error'
```

Add a first-class conflict state instead of overloading `error`.

## Proposed User Flow

### 1. Conflict Detection

Sync detects a conflict when the upstream checksum changed since the last
baseline and the local checksum also differs from that baseline.

For Drive-backed files:

```text
currentRemoteChecksum !== lastRemoteChecksum
localChecksum !== lastRemoteChecksum
```

The same state can also occur when the local record has user content but no
baseline checksum and Drive already has content.

### 2. Sync Stops

The app does not upload local content, download upstream content, or create a
new Drive file.

The local notebook remains editable. Additional local edits keep updating the
local mirror, but automatic upstream sync stays blocked while the conflict is
present.

### 3. Tab Shows Conflict

The notebook tab sync indicator changes from pending/error styling to a
conflict-specific state.

Recommended presentation:

- color: amber or red-orange,
- aria label: `Notebook has a sync conflict. Click to review differences.`,
- click behavior: open the conflict diff tab.

The indicator should not retry sync when the status is `conflicted`. Retrying
without user intent would rediscover the same conflict.

### 4. Diff Tab Opens

Clicking the conflict indicator opens a workspace document tab using the
existing notebook diff renderer.

Labels:

- left: `Upstream version`
- right: `Local version`

The diff should compare the upstream snapshot captured when the conflict was
detected against the current local notebook. If the user edits the local
notebook while the diff tab is open, V0 can require reopening the diff to see a
fresh comparison.

### 5. User Resolves Manually

The user edits the local notebook until it has the desired final content.

V0 does not offer per-cell accept/reject. The diff is a review surface, not an
editor.

### 6. User Saves Local Version

The diff tab shows a primary **Save local version** button.

Clicking it:

1. Reads the current local notebook.
2. Writes it to the original upstream file.
3. Updates `lastRemoteChecksum`, `lastUpstreamVersion`, `md5Checksum`,
   `lastSynced`, and clears the conflict metadata.
4. Leaves `remoteId` pointing at the original upstream file.
5. Updates the tab sync indicator to `synced`.

If the upstream changed again after the conflict snapshot was captured, V0
should still ask for confirmation before overwriting:

```text
The upstream file changed again since this conflict was detected.
Saving local version will replace the latest upstream version.
```

The first implementation can make this a browser `confirm(...)`. A polished
dialog can follow.

## Data Model

Add conflict metadata to `LocalFileRecord`.

Illustrative shape:

```ts
export type NotebookSyncStatus =
  | 'local-only'
  | 'synced'
  | 'pending'
  | 'pending-upstream-create'
  | 'syncing'
  | 'conflicted'
  | 'error'

export interface NotebookConflictState {
  detectedAt: string
  upstreamUri: string
  localChecksumAtDetection: string
  baseChecksum?: string
  baseVersion?: UpstreamVersion
  upstreamVersion: UpstreamVersion
  upstreamChecksum: string
  upstreamDoc: string
}

export interface LocalFileRecord {
  // existing fields...
  conflict?: NotebookConflictState
}
```

Persist `upstreamDoc` in IndexedDB so the conflict diff is stable even if Drive
changes again or auth is temporarily unavailable. This duplicates one notebook
payload only while a conflict is unresolved. Clear it after the user resolves
or intentionally discards the conflict.

Use the existing `lastUpstreamVersion` as the base version where possible. It
is diagnostic metadata, not the merge base content.

## Sync Behavior

Replace `handleConflict(...)` with `recordConflict(...)` for Drive-backed
notebooks.

Current behavior:

```text
conflict detected
  -> create new timestamped Drive file
  -> save local notebook into that file
  -> update local record remoteId to new file
  -> report synced
```

Proposed behavior:

```text
conflict detected
  -> load current upstream notebook
  -> serialize upstream notebook
  -> update local record conflict metadata
  -> keep remoteId unchanged
  -> report conflicted
```

`getSyncState(localUri)` should return `conflicted` before `pending` or
`error` if `record.conflict` exists.

`listDriveBackedFilesNeedingSync()` should not enqueue conflicted files for
automatic sync. They need a user resolution action, not a retry loop.

`save(localUri, notebook)` should continue to persist local edits while the
record is conflicted. It should not enqueue upstream sync for conflicted
records unless we introduce a separate manual resolution method.

Add a new method on `LocalNotebooks`:

```ts
async resolveConflictWithLocal(localUri: string): Promise<void>
```

This method performs the explicit overwrite and clears `record.conflict` only
after the upstream save succeeds and fresh Drive version metadata is recorded.

## Diff Tab Integration

Add a conflict-specific path that creates a `NotebookDiffDocument` from the
stored conflict snapshot and the current local notebook.

Possible API:

```ts
async openConflictDiff(localUri: string): Promise<void>
```

Implementation steps:

1. Read the `LocalFileRecord`.
2. Parse `record.conflict.upstreamDoc` into the base notebook.
3. Parse `record.doc` into the compare notebook.
4. Compute `computeNotebookDiff(baseNotebook, compareNotebook, ...)`.
5. Register and show the diff document.

Extend `NotebookDiffDocument` with optional action metadata:

```ts
export interface NotebookDiffDocument {
  id: string
  base: { label: string; revisionId?: string }
  compare: { label: string; revisionId?: string }
  diff: NotebookDiff
  resolution?: {
    kind: 'notebook-sync-conflict'
    localUri: string
  }
}
```

`NotebookDiffView` can render **Save local version** only when
`resolution.kind === "notebook-sync-conflict"`.

## UX Details

The tab indicator remains the main entry point because users already look there
for Drive sync state.

Suggested labels:

- `synced`: `Notebook is synced`
- `pending`: `Notebook has local changes pending upstream sync. Click to sync now.`
- `conflicted`: `Notebook has a sync conflict. Click to review differences.`
- `error`: `Notebook sync failed. Click to retry.`

The diff tab header should include a compact conflict summary:

```text
This notebook has local changes and upstream changes. Review the diff, edit the
local notebook if needed, then save the local version to replace upstream.
```

The button text should be explicit:

- Primary: `Save local version`
- Secondary follow-up, not V0: `Keep upstream version`
- Secondary follow-up, not V0: `Save local as copy`

Do not label the V0 action `Resolve` by itself. The action overwrites upstream,
so the button should say that local content wins.

## Failure Handling

If recording the conflict snapshot fails after detecting a checksum conflict,
leave the notebook local content untouched and set `lastSyncError`. The app
should prefer a visible sync error over unsafe upload or download.

If the upstream file is deleted or inaccessible while opening the diff, show a
diff-tab error with the stored local content and the original Drive URI. The
stored `upstreamDoc` should usually make this avoidable.

If **Save local version** fails due to auth, network, or Drive permissions, keep
the conflict state and show the error in the diff tab and tab indicator.

If **Save local version** succeeds but fetching fresh version metadata fails,
keep the local content saved and set `lastSyncError` so a later sync can
refresh metadata. Do not restore the old conflict state after a successful
upstream write.

## Test Plan

Add focused tests around the conflict state transition:

- Drive conflict no longer creates a timestamped file or changes `remoteId`.
- Drive conflict stores `conflict.upstreamDoc` and returns sync status
  `conflicted`.
- `listDriveBackedFilesNeedingSync()` excludes conflicted records.
- Local edits remain persisted while conflicted.
- Clicking the tab indicator for `conflicted` opens a diff tab instead of
  retrying sync.
- `resolveConflictWithLocal(...)` writes to the original Drive URI, clears
  conflict metadata, and updates version metadata.
- If upstream changed again before `resolveConflictWithLocal(...)`, the UI asks
  for confirmation before overwriting.

## Rollout Plan

1. Add `conflicted` sync status and conflict metadata migration.
2. Replace Drive `handleConflict(...)` with conflict recording.
3. Update sync-state queries and tab indicator behavior.
4. Add conflict diff document creation.
5. Add **Save local version** to conflict diff tabs.
6. Remove or quarantine tests that expect automatic conflict copy creation.

## Follow-Up Work

- Add **Keep upstream version**, which replaces local content with the stored
  upstream snapshot or latest upstream content after confirmation.
- Add **Save local as copy**, which reintroduces timestamped copy creation as an
  explicit action.
- Add cell-level accept local/upstream controls.
- Add three-way merge using the last synced base content once we persist or can
  reliably fetch that base.
- Add a conflict summary in the side panel or Drive status surface for users
  with multiple conflicted notebooks.

## Open Questions

- Should the conflict snapshot live inline on `LocalFileRecord` or in a
  separate IndexedDB table keyed by local URI? Inline is simpler for V0; a table
  is cleaner if we add multiple conflict snapshots or version history.
- Should local edits while conflicted automatically refresh the open diff tab?
  V0 can require reopening the diff. Live refresh is nicer but adds subscription
  complexity to a read-only review surface.
- Should V0 include **Keep upstream version**? It is useful, but it is also a
  destructive local overwrite and needs the same confirmation care as **Save
  local version**.
