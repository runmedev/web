# Track Upstream Versions and Surface Sync State

Date: 2026-04-08

Issues:

- https://github.com/runmedev/web/issues/165
- https://github.com/runmedev/web/issues/157

## Summary

Make notebook persistence more uniform, make upstream sync more observable, and
make local-vs-upstream state explicit to the user.

Recommended near-term changes:

1. Keep the data-loss defense for Issue 165 small and Drive-focused.
2. Prioritize Issue 157: consolidate notebook persistence into one local mirror
   model backed by IndexedDB.
3. Represent every notebook with an explicit upstream URI:
   - `gdrive://...` or the current Drive URL for Google Drive
   - `file://...` for local filesystem
   - `local://file/...` for browser-only IndexedDB notebooks
4. Track optional upstream revision metadata alongside the existing content
   checksum.
5. Add generic logging and UI affordances for local mirror vs upstream sync
   state.

Keep using content checksum (`md5Checksum`) as the sync/conflict predicate where
possible. Upstream revision IDs should be persisted as provenance and diagnostic
metadata, not as the only proof that two notebook payloads are equal.

## Background

Runme already uses IndexedDB as a local mirror for Google Drive notebooks. For
Drive-backed notebooks the local record stores:

- the local notebook JSON
- a Drive file URI
- the last remote content checksum we observed
- a local content checksum
- the last successful sync timestamp

[Issue 165](https://github.com/runmedev/web/issues/165) reported possible data loss around expired Drive auth. We have not
reproduced the loss, but investigation found two risky areas:

1. Local content could be overwritten by Drive content when no remote checksum
   baseline had been recorded.
2. Creating a new notebook from a Drive Explorer location while auth is expired
   can produce a local-only notebook. Because it has no `remoteId`, the
   auth-recovery Drive reconciler will not upload it.

[Issue 157](https://github.com/runmedev/web/issues/157) proposes consolidating
notebook storage: use `runme-local-notebooks` as the canonical local mirror, and
treat local filesystem plus `contents://` as upstream backends, just like Drive.

This cleanup should happen before we build a tab-level sync-state UI. The UI
should render "is my local notebook mirror synced to its upstream?", not "is my
Google Drive file synced?".

## Current Interface Model

Today's relevant layers are:

- `NotebookData`: in-memory notebook model used by the editor
- `NotebookStore`: generic CRUD interface for notebook-like stores
- `LocalNotebooks`: IndexedDB-backed local/Drive mirror used for `local://`
  records
- `DriveNotebookStore`: Google Drive backend used by `LocalNotebooks`
- `FilesystemNotebookStore`: local filesystem backend with a separate IndexedDB
  handle database
- `ContentsNotebookStore`: HTTP contents backend
- `NotebookStoreContext`: React context that currently exposes
  `LocalNotebooks`, not an arbitrary `NotebookStore`

This means the intended abstraction exists, but storage is still split:

```text
Drive notebook -> LocalNotebooks / runme-local-notebooks -> DriveNotebookStore
Browser-only notebook -> LocalNotebooks / runme-local-notebooks
Filesystem notebook -> FilesystemNotebookStore / runme-fs-workspaces
Contents notebook -> ContentsNotebookStore
```

Issue 157 should make the first hop uniform:

```text
NotebookData / UI
  -> local://file/<id>
  -> LocalNotebooks local mirror
  -> optional upstream backend selected by upstream URI
```

## Proposal 1: Consolidate Around a Local Mirror

Use `runme-local-notebooks` as the canonical app-facing notebook store.

All open/editable notebooks should have a `local://file/<id>` identity and an
IndexedDB mirror record.

Support three backend categories explicitly:

| Backend | Meaning | Upstream URI |
| --- | --- | --- |
| IndexedDB only | browser-only notebook; no external file | `local://file/<same-id>` |
| Google Drive | Drive blob file | current Drive URL or future `gdrive://file/<drive-id>` |
| Local filesystem | file selected through File System Access API | `file://...` |

`contents://...` can follow the same upstream-backend pattern if/when we want
contents-backed notebooks to be local-first editable.

## Proposal 2: Replace Empty `remoteId` With Explicit Upstream URI

Today `LocalFileRecord.remoteId === ""` means "this notebook has no Drive
remote". That made it easy to conflate "browser-only notebook" with "we failed
to attach the remote after creating a file from a Drive folder."

Change the local record model so the upstream is always explicit.

Illustrative shape:

```ts
interface LocalFileRecord {
  id: string;          // local://file/<uuid>
  upstreamUri: string; // local://file/<uuid> | file://... | https://drive...
  doc: string;
  md5Checksum: string;
}
```

For browser-only IndexedDB notebooks:

```text
id = local://file/123
upstreamUri = local://file/123
```

For Drive-backed notebooks:

```text
id = local://file/123
upstreamUri = https://drive.google.com/file/d/<drive-id>/view
```

For filesystem-backed notebooks:

```text
id = local://file/123
upstreamUri = file:///absolute/path/to/notebook.json
```

Then the URI scheme selects the upstream backend. Empty string stops being part
of the state machine.

Migration note: add `upstreamUri` first, populate it from `remoteId || id`, keep
`remoteId` as a compatibility alias for one release, then remove empty-string
special cases.

## Proposal 3: Add a Generic Upstream Backend Interface

Keep `NotebookStore` as the UI/app-facing notebook CRUD abstraction, but add a
smaller backend interface for syncing local mirror records to upstream content.

Illustrative shape:

```ts
interface NotebookUpstreamBackend {
  load(uri: string): Promise<UpstreamLoadResult>;
  save(uri: string, doc: string): Promise<UpstreamSaveResult>;
  getVersion?(uri: string): Promise<UpstreamVersion | null>;
}
```

`LocalNotebooks` owns IndexedDB records, checksum comparison, sync scheduling,
conflict handling, and local recovery policy. It delegates upstream
load/save/version calls to the backend selected by `upstreamUri`.

This keeps tabs and notebook editing local-first, while making Drive and
filesystem "just different upstream backends."

## Proposal 4: Model Upstream Versions as Optional Metadata

Add generic upstream version metadata. Not every backend has durable revision
IDs.

Illustrative shape:

```ts
interface UpstreamVersion {
  checksum?: string;
  revisionId?: string;
  objectVersion?: string;
  modifiedTime?: string;
  sizeBytes?: number;
}

interface LocalFileRecord {
  lastUpstreamVersion?: UpstreamVersion;
}
```

Backend examples:

- Google Drive fills `checksum = files.md5Checksum`,
  `revisionId = files.headRevisionId`, and `objectVersion = files.version`.
- Local filesystem can fill `checksum` by hashing file contents. It may also
  fill `modifiedTime` and `sizeBytes`, but it does not need a `revisionId`.
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

Revision ID/version should answer "which Drive version did we last touch?" and
"what revision did this local cache come from?", but should not replace checksum
comparison.

## Proposal 5: Persist Drive Revision Provenance

Drive metadata should be adapted into `UpstreamVersion`, not exposed to tab UI
as a Google-specific state object.

Illustrative shape:

```ts
function toUpstreamVersion(metadata: DriveFileMetadata): UpstreamVersion {
  return {
    checksum: metadata.md5Checksum,
    revisionId: metadata.headRevisionId,
    objectVersion: metadata.version,
  };
}
```

Update the Drive store to fetch and return this object in metadata paths that
currently fetch `md5Checksum,headRevisionId,version` but keep only
`md5Checksum`.

## Proposal 6: Structured Logging for Overwrites and Revision Transitions

Use `appLogger` for sync events that are important for data-loss diagnosis.

Log before replacing local notebook JSON with upstream JSON:

```text
event: Overwriting local notebook content with upstream content
attrs:
  scope: storage.notebook.sync
  localUri
  upstreamUri
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
  scope: storage.notebook.sync
  localUri
  upstreamUri
  uploadedChecksum
  uploadedRevisionId
  uploadedObjectVersion
```

This gives support/debugging enough information to compare IndexedDB state,
Drive metadata, and user reports.

## Proposal 7: Add Notebook Tab Sync Indicator

Add a compact sync indicator to each notebook tab.

Suggested states:

- green circle: local notebook content matches the last upstream checksum
- red circle: local content has not been uploaded to its upstream
- gray hollow circle: notebook is stored in IndexedDB only
- spinner or pulsing outline: upstream sync is currently running
- warning triangle or red slash: last upstream sync failed or auth is needed

Click behavior:

- green: no-op or show a tooltip with last synced revision/time
- red: force an immediate upstream sync for that notebook
- failed/auth-needed: start the required login/reconnect flow, then force
  immediate sync
- local-only: show "This notebook is stored only in this browser"

The important product behavior is that the red state should be actionable.
Clicking it should bypass the existing debounce and try to save now.

## Proposal 8: Add Generic Mirror Sync State

After the Issue 157 refactor, expose sync state in terms of the local mirror and
its optional upstream. Do not expose a Google-Drive-specific status object to
notebook tabs.

Existing APIs already provide some of the needed context:

- `NotebookStoreItem.remoteUri` / future `upstreamUri`: tells the UI where a
  local mirror syncs
- `LocalNotebooks.listDriveBackedFilesNeedingSync()`: current Drive-specific
  pending-upload query
- `LocalNotebooks.enqueueDriveBackedFilesNeedingSync()`: current Drive-specific
  auth-recovery requeue
- `NotebookData.subscribe()`: tells React that notebook content changed

Gaps:

- no generic per-notebook mirror sync status for a tab
- no public immediate sync method; background sync is currently debounced
- no subscription for metadata-only sync changes, such as "upload completed"

Add a generic sync-state read model. This can be a method on `LocalNotebooks` if
`LocalNotebooks` remains the local mirror service; the type should not be
Drive-specific.

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
  upstreamUri: string;
  lastSynced?: string;
  lastUpstreamVersion?: UpstreamVersion;
  lastError?: string;
}
```

Then expose:

```ts
class LocalNotebooks {
  getSyncState(localUri: string): Promise<NotebookSyncState>;
  syncNow(localUri: string): Promise<void>;
  subscribeSync(localUri: string, listener: () => void): () => void;
}
```

`syncNow` should call the same synchronization state machine as the
debounced background sync; it should not create a second upload path.

The first implementation can omit `subscribeSync` and poll/recompute when
NotebookData emits, if that is enough for the tab indicator. Add a subscription
only when we need tabs to update immediately after metadata-only sync events.

## Proposal 9: Block Drive New-File Creation While Drive Auth Is Unavailable

Start with the simpler UX:

If the user is creating a new file from a mounted Google Drive folder, require
Drive auth before creating any local notebook record.

Flow:

1. User clicks "new file" in a Drive folder.
2. UI checks Drive auth.
3. If auth is available, create the Drive file first.
4. Create the IndexedDB mirror only after Drive returns the file ID.
5. Persist initial notebook content locally.
6. Upload that same content and store checksum/revision metadata.

If auth is unavailable:

1. Do not create a local notebook.
2. Start login flow or show an auth-required error.
3. Keep the user in the same Explorer location.
4. Ask the user to retry creation after auth completes.

This avoids orphaning a local notebook that the Drive reconciler cannot find.

## Deferred Option: Pending Upstream Creation Queue

Offline upstream-file creation can be supported later, but only with an explicit
pending creation model.

That model would need to persist:

- intended parent Drive folder URI
- requested filename
- local notebook URI
- intended upstream backend
- creation status
- retry/auth status

On auth recovery the reconciler would create the remote file, attach its URI to
the existing local record, and immediately upload local JSON.

Do not implement "offline Drive file creation" by silently creating a local-only
notebook in the Drive Explorer tree.

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

1. Keep the Issue 165 defensive overwrite fix focused and merged first.
2. Design and implement the Issue 157 local-mirror consolidation.
3. Replace empty `remoteId` semantics with explicit `upstreamUri`; use
   `upstreamUri = localUri` for IndexedDB-only notebooks.
4. Adapt Drive, filesystem, and optionally contents behind upstream backend
   interfaces.
5. Add optional `UpstreamVersion` metadata to local mirror records.
6. Add structured appLogger events for uploads, downloads, conflicts, and
   local-overwrite.
7. Add generic `syncNow` and sync-state API on the local mirror service.
8. Add tab-level sync indicator using the sync-state API.
9. Wire red/failed indicator clicks to immediate sync or required auth/reconnect.
10. Change Explorer "new Drive file" flow to require auth before creating the
   local mirror.
11. Add tests for expired-auth new-file creation.

## Test Plan

- Create a Drive-backed notebook and verify IndexedDB records checksum,
  head revision ID, and Drive version after initial upload.
- Create a browser-only notebook and verify its upstream URI is its local URI.
- Open/mirror a filesystem notebook and verify its upstream URI is `file://...`.
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

- Should the tab indicator be shown only on upstream-backed tabs, or on all tabs
  with a gray IndexedDB-only state?
  * Decision: show a gray state for IndexedDB-only notebooks
- Should the sync indicator live in the tab, the notebook toolbar, or both?
  * Decision: tab should be sufficient to start with
- Should successful immediate sync show a toast, or is the indicator transition
  sufficient?
  * Decision: Don't show a toast
- Should we keep a bounded local recovery snapshot for every remote-to-local
  overwrite?
  * Decision: I don't think we need to do this right now.
- Should we mark the current Drive revision `keepForever` when a user explicitly
  asks to preserve or restore it?
  * Decision: I don't think we need to do this right now.
