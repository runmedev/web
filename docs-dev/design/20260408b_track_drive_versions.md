# Track Upstream Versions and Surface Sync State

Date: 2026-04-08

Issues:

- https://github.com/runmedev/web/issues/165
- https://github.com/runmedev/web/issues/157

Builds on:

- `docs-dev/design/20260408a_refactor_notebooks.md`
- PR #168, which removed the old `NotebookStore` routing path, made
  `LocalNotebooks` the app-facing notebook store, and removed the unused
  contents-service storage path.

## Summary

After the local-mirror refactor, make upstream sync more observable and make
local-vs-upstream state explicit to the user.

Recommended changes:

1. Track optional upstream revision metadata alongside content checksums in
   `LocalFileRecord`.
2. Adapt Google Drive revision metadata into that generic upstream-version
   model without making notebook tabs Drive-specific.
3. Generalize the existing overwrite logging so every upstream-to-local
   replacement includes revision/checksum context.
4. Add a small per-notebook sync-state indicator in the tab bar.
5. Let users click the indicator to force immediate sync through
   `LocalNotebooks.sync(localUri)`.
6. Reject new Drive-file creation while Drive auth is unavailable until we have
   a durable pending-upstream-creation queue.

Keep using content checksum (`md5Checksum`) and upstream content checksum
(`lastRemoteChecksum`) as the sync/conflict predicate where possible. Upstream
revision IDs should be persisted as provenance and diagnostic metadata, not as
the only proof that two notebook payloads are equal.

## Background

[Issue 165](https://github.com/runmedev/web/issues/165) reported possible data loss around expired Drive auth. We have not
reproduced the loss, but investigation found two risky areas:

1. Local content could be overwritten by Drive content when no remote checksum
   baseline had been recorded.
2. Creating a new notebook from a Drive Explorer location while auth is expired
   can produce a browser-only local notebook instead of a Drive-backed mirror.

PR #167 added conservative Drive sync guards and logging. This document captures
follow-up work that should happen after the #157 / local-mirror cleanup. PR
#168 has now landed that cleanup.

The UI should render "is my local notebook mirror synced to its upstream?", not
"is my Google Drive file synced?".

## Current Refactored Code State

The app-facing notebook path is now:

```text
NotebookData / editor tabs
  -> local://file/<id>
  -> LocalNotebooks / IndexedDB
  -> optional upstream selected by LocalFileRecord.remoteId
```

`LocalFileRecord` currently stores:

```ts
interface LocalFileRecord {
  id: string;                 // local://file/<uuid>
  name: string;
  remoteId: string;           // local://file/<uuid> | fs://... | Drive HTTPS URL
  markdownUri?: string;
  lastRemoteChecksum: string;
  lastSynced: string;
  doc: string;
  md5Checksum: string;
}
```

`lastRemoteChecksum` is a legacy field name. After the refactor it is the last
observed upstream content checksum for Drive and File System Access, not only
Google Drive.

The supported upstreams after PR #168 are:

| Upstream | `remoteId` shape | Notes |
| --- | --- | --- |
| Browser-only IndexedDB | `remoteId === id` (`local://file/<uuid>`) | No external sync target. |
| Google Drive | `https://drive.google.com/...` | Drive-only flows must use `isDriveItemUri`, not permissive `parseDriveItem`. |
| File System Access | `fs://workspace/<workspace-id>/file/<path>` | Browser handle-backed upstream; do not document this as `file://`. |

The contents-service path has been removed. Do not design new sync/version
state around `contents://...` unless a real backend service and product entry
point are reintroduced.

`StorageBrowser` is now the narrow workspace-tree contract used by
`WorkspaceExplorer`. It is not the editor persistence API and deliberately does
not include notebook content load/save.

## Proposal 1: Model Upstream Versions as Optional Metadata

Add generic upstream version metadata. Not every backend has durable revision
IDs.

Illustrative shape:

```ts
interface UpstreamVersion {
  checksum?: string;
  revisionId?: string;
  modifiedTime?: string;
  sizeBytes?: number;
}

interface LocalFileRecord {
  lastUpstreamVersion?: UpstreamVersion;
  lastSyncError?: string;
}
```

Adding these fields requires a new Dexie migration after schema version 4.
Backfill should leave `lastUpstreamVersion` undefined for existing records and
clear `lastSyncError`.

Backend examples:

- Google Drive fills `checksum = files.md5Checksum`,
  `revisionId = files.headRevisionId`, and may later fill `modifiedTime` or
  `sizeBytes` if those help diagnostics.
- File System Access fills `checksum` by hashing the serialized file contents.
  It may later fill `modifiedTime` and `sizeBytes` from `File` metadata, but it
  does not need a `revisionId`.
- Browser-only IndexedDB notebooks can omit upstream revision metadata, or use
  the local checksum as the only version signal.

Sync/conflict code should tolerate missing revision IDs. Revision ID is useful
for logs, diagnostics, and future "restore revision" UI, but it is optional.

## Google Drive Metadata Model

The Drive `files.get` response has several version-like fields:

- `md5Checksum`: content checksum for blob files
- `headRevisionId`: ID of the current file-content revision for blob files
- `version`: server object counter

Drive `files.version` is deliberately broader than content. Google documents it
as a monotonically increasing number reflecting every server-side file change,
including changes that are not visible to the user.

Do not persist `files.version` as part of `UpstreamVersion` unless we add a
separate diagnostics-only use case. It is too broad for sync correctness and is
not the user-visible revision identity we need for restore/version UI.

Drive `headRevisionId` corresponds to the current content revision for our JSON
blob files. It is the API-level identity closest to the "Current version" row in
the Drive "Manage versions" UI.

The Drive Revisions API can list revisions for a file and returns revision IDs.
For blob files, revision metadata can also include `md5Checksum`.

## Design Principle

Use checksums for correctness. Use revision IDs for explainability.

The sync state machine should continue comparing content identities:

```text
local md5Checksum
last observed upstream checksum
current upstream checksum
```

Revision ID/version should answer "which upstream version did we last touch?"
and "what revision did this local cache come from?", but should not replace
checksum comparison.

## Proposal 2: Persist Drive Revision Provenance

`LocalNotebooks` remains the app-facing API. Notebook tabs and other UI should
ask `LocalNotebooks` for sync/version state; they should not import
`DriveNotebookStore`, call Drive APIs, or receive a Google-specific status
object.

The Drive-specific work in this proposal is only an internal adapter step:
capture the Drive metadata that `LocalNotebooks` needs to persist
`lastRemoteChecksum` and `lastUpstreamVersion`.

Update the Drive store to fetch and return this object in metadata paths that
currently fetch `md5Checksum,headRevisionId,version` but keep only
`md5Checksum`. As part of this change, stop requesting `version` from
`VERSION_FIELDS` unless a concrete diagnostics-only use case is added.

Current code detail: `DriveNotebookStore` already defines:

```ts
const VERSION_FIELDS = "md5Checksum,headRevisionId,version";
```

It requests those fields in `load`, `save`, and `getChecksum`, but it only
reads/persists `md5Checksum`. Add a typed metadata return value rather than
adding new ad hoc `getHeadRevisionId` calls:

```ts
interface DriveVersionMetadata {
  md5Checksum?: string;
  headRevisionId?: string;
}

class DriveNotebookStore {
  getVersionMetadata(uri: string): Promise<DriveVersionMetadata | null>;
}
```

Then `LocalNotebooks.syncFile(...)` can translate that Drive metadata into the
generic `LocalFileRecord` fields:

```ts
lastRemoteChecksum = metadata.md5Checksum ?? "";
lastUpstreamVersion = {
  checksum: metadata.md5Checksum,
  revisionId: metadata.headRevisionId,
};
```

This translation belongs inside `LocalNotebooks` or a private storage helper,
not in the tab UI.

## Proposal 3: Structured Logging for Overwrites and Revision Transitions

Use `appLogger` for sync events that are important for data-loss diagnosis.

Current code already logs upstream-to-local replacement via
`logRemoteOverwriteLocalDoc(...)`, but the event is still named
"Overwriting local notebook content with Drive content" and only includes
checksums/byte counts. Because the same helper is used by the filesystem
upstream path, rename the event and scope to be upstream-generic when adding
version metadata.

Log before replacing local notebook JSON with upstream JSON:

```text
event: Overwriting local notebook content with upstream content
attrs:
  scope: storage.local.sync
  localUri
  remoteId
  localChecksum
  previousUpstreamChecksum
  upstreamChecksum
  previousUpstreamRevisionId
  upstreamRevisionId
  previousUpstreamObjectVersion
  upstreamObjectVersion
  localBytes
  upstreamBytes
  reason
```

Log after successful upload:

```text
event: Uploaded local notebook content to upstream
attrs:
  scope: storage.local.sync
  localUri
  remoteId
  uploadedChecksum
  uploadedRevisionId
  uploadedObjectVersion
```

This gives support/debugging enough information to compare IndexedDB state,
upstream metadata, and user reports.

## Proposal 4: Add Notebook Tab Sync Indicator

Add a compact sync indicator to each notebook tab.

Suggested states:

- green circle: local notebook content matches the last upstream checksum
- red circle: local content has not been uploaded to its upstream
- gray hollow circle: notebook is stored in IndexedDB only
- spinner or pulsing outline: upstream sync is currently running
- warning triangle or red slash: last upstream sync failed or auth/reconnect is
  needed

Click behavior:

- green: no-op or show a tooltip with last synced revision/time
- red: force an immediate upstream sync for that notebook
- failed/auth-needed: start the required login/reconnect flow, then force
  immediate sync
- IndexedDB-only: show "This notebook is stored only in this browser"

The important product behavior is that the red state should be actionable.
Clicking it should bypass the existing debounce and try to save now.

## Proposal 5: Add Generic Mirror Sync State

With the Issue 157 refactor landed, expose sync state in terms of the local
mirror and its optional upstream. Do not expose a Google-Drive-specific status
object to notebook tabs.

Illustrative shape:

```ts
type NotebookSyncStatus =
  | "local-only"
  | "synced"
  | "pending"
  | "syncing"
  | "error";

interface NotebookSyncState {
  status: NotebookSyncStatus;
  localUri: string;
  remoteId: string;
  lastSynced?: string;
  lastUpstreamVersion?: UpstreamVersion;
  lastError?: string;
}
```

Then expose these through the local mirror service:

```ts
class LocalNotebooks {
  getSyncState(localUri: string): Promise<NotebookSyncState>;
  subscribeSync(localUri: string, listener: () => void): () => void;
}
```

Do not add a second upload path. The class already exposes
`sync(localUri: string): Promise<void>`; the UI click handler can call that
method directly or through a thin `syncNow` alias if a clearer UI-facing name is
needed.

`getSyncState` can be derived from the existing fields at first:

- `remoteId === id` or `remoteId` is empty: `local-only`
- upstream is Drive or `fs://...` and `md5Checksum === lastRemoteChecksum`:
  `synced`
- upstream is Drive or `fs://...` and `md5Checksum !== lastRemoteChecksum`:
  `pending`
- current in-memory sync subject is running: `syncing`
- last sync attempt failed: `error` once we add `lastSyncError` or equivalent
  metadata

The first implementation can omit `subscribeSync` and poll/recompute when
NotebookData emits, if that is enough for the tab indicator. Add a subscription
only when we need tabs to update immediately after metadata-only sync events.

## Proposal 6: Block Drive New-File Creation While Drive Auth Is Unavailable

Start with the simpler UX, but do not rely on a preflight auth check as the
correctness mechanism. A token that is valid before creation can still expire
before the network request finishes. The invariant should be stronger:

If the user is creating a new file from a mounted Google Drive folder, do not
create the local notebook mirror until the Drive file has been created
successfully and we have its Drive URI.

Current gap after PR #168: `WorkspaceExplorer` calls `LocalNotebooks.create`
for local mirrored Drive folders. `LocalNotebooks.create` creates a
`local://file/...` record first, then asynchronously calls
`DriveNotebookStore.create(parent.remoteId, name)` if the parent folder has a
Drive `remoteId`. Because `DriveNotebookStore` uses non-interactive
`ensureAccessToken({ interactive: false })`, expired auth can make that async
Drive create fail and leave the notebook as browser-only. This is exactly the
case we should remove.

`LocalFileRecord` does not currently store its parent folder ID. Parent
membership is persisted on `LocalFolderRecord.children`, and `LocalNotebooks`
can recover a file's parent by scanning folders. That means a reload after the
local file insert but before the async Drive create completes leaves a durable
local file whose `remoteId` looks browser-only. We can infer that it sits under a
Drive-backed local folder, but there is no explicit "pending Drive create for
parent X" state on the file.

Flow:

1. User clicks "new file" in a Drive folder.
2. `LocalNotebooks.create(...)` detects that the parent is Drive-backed.
3. It awaits `DriveNotebookStore.create(parent.remoteId, name)`.
4. If Drive auth is missing, expired, or fails during the request, the awaited
   Drive create rejects.
5. On rejection, do not create a local notebook record; surface auth-required
   or create-failed UI.
6. On success, create the IndexedDB mirror using the returned Drive URI as
   `remoteId`.
7. Persist the same initial notebook content locally and store checksum/revision
   metadata.

If auth is unavailable:

1. Do not create a local notebook.
2. Start login flow or show an auth-required error.
3. Keep the user in the same Explorer location.
4. Ask the user to retry creation after auth completes.

This avoids creating an IndexedDB-only notebook when the user intended to create
a Drive-backed notebook.

This does not eliminate all token-expiry races. A token can still expire after
the Drive file is created and before a later autosave. That is acceptable if the
local mirror already has a Drive `remoteId`: the save should move into
`pending` or `error` sync state and retry after auth is restored. The bug to
avoid here is the initial-create failure mode where the notebook is accidentally
left as browser-only because Drive creation failed after the local record was
already inserted.

If we decide to keep a local-first create flow, we should make that state
explicit instead of relying on folder-child inference. That would require adding
fields such as `pendingUpstreamParentId`, `pendingUpstreamName`, and
`lastSyncError`, then a startup reconciler that resumes or surfaces pending
Drive creates. That is effectively the pending-upstream-creation queue described
below, so the simpler first step should be remote-first create for Drive-backed
folders.

## Deferred Option: Pending Upstream Creation Queue

Offline upstream-file creation can be supported later, but only with an explicit
pending creation model.

That model would need to persist:

- intended parent upstream folder URI
- requested filename
- local notebook URI
- intended upstream backend
- creation status
- retry/auth status

On auth recovery the reconciler would create the upstream file, attach its URI
to `remoteId`, and immediately upload local JSON.

Do not implement "offline Drive file creation" by silently creating a
browser-only notebook in the Drive Explorer tree.

## Deferred Option: Restore Earlier Drive Revision

Tracking `headRevisionId` enables a future restore UI, but a complete restore
feature should query the Drive Revisions API on demand.

Possible v1 flow:

1. Open "Drive versions" from the notebook tab or file menu.
2. Call `revisions.list(fileId)`.
3. Render revision ID, modified time, size, checksum, and author when available.
4. Let the user open a revision as a read-only comparison copy.
5. Add "restore" after comparison is available.

We should also consider saving a local IndexedDB recovery snapshot before any
local-overwrite. That is more reliable than relying on Drive to retain every
old blob revision forever.

## Rollout Plan

1. Land the Issue 165 defensive overwrite fix.
2. Done: implement the Issue 157 local-mirror consolidation described in
   `20260408a_refactor_notebooks.md`.
3. Add optional `UpstreamVersion` metadata to local mirror records.
4. Adapt Drive metadata into `UpstreamVersion`.
5. Generalize structured appLogger events for uploads, downloads, conflicts,
   and local-overwrite, preserving the existing overwrite logging but adding
   revision metadata.
6. Add generic sync-state API on the local mirror service; use the existing
   `LocalNotebooks.sync(localUri)` method for immediate sync.
7. Add tab-level sync indicator using the sync-state API.
8. Wire red/failed indicator clicks to immediate sync or required auth/reconnect.
9. Change Explorer/LocalNotebooks "new Drive file" flow to require auth before
   creating the local mirror.
10. Add tests for expired-auth new-file creation.

## Test Plan

- Create a Drive-backed notebook and verify IndexedDB records checksum,
  head revision ID, and Drive version after initial upload.
- Create a browser-only notebook and verify sync state is IndexedDB-only.
- Open/mirror a filesystem notebook and verify sync state uses `fs://...`.
- Edit a Drive-backed notebook while auth is unavailable; verify tab indicator
  turns red.
- Click red indicator after restoring auth; verify upload happens immediately
  and indicator turns green.
- Create new notebook from a Drive folder while auth is unavailable; verify no
  local file record is created and the UI prompts for login.
- Modify upstream Drive content from another browser session; verify local
  overwrite is logged with previous and current revision metadata.
- Modify local and upstream concurrently; verify conflict path still preserves
  local content.

## Open Questions

- Should the sync indicator live in the tab, the notebook toolbar, or both?
  - Decision: tab should be sufficient to start with
- Should successful immediate sync show a toast, or is the indicator transition
  sufficient?
  - Decision: Don't show a toast
- Should we keep a bounded local recovery snapshot for every upstream-to-local
  overwrite?
  - Decision: not right now
- Should we mark the current Drive revision `keepForever` when a user explicitly
  asks to preserve or restore it?
  - Decision: not right now
