# Track Upstream Versions and Surface Sync State

Date: 2026-04-08

Issues:

- https://github.com/runmedev/web/issues/165
- https://github.com/runmedev/web/issues/157

Depends on: `docs-dev/design/20260408a_refactor_notebooks.md`

## Summary

After the local-mirror refactor, make upstream sync more observable and make
local-vs-upstream state explicit to the user.

Recommended changes:

1. Track optional upstream revision metadata alongside content checksums.
2. Adapt Google Drive revision metadata into that generic upstream-version
   model.
3. Add generic logging for every sync transition that can replace local mirror
   content.
4. Add a small per-notebook sync-state indicator in the tab bar.
5. Let users click the indicator to force immediate sync.
6. Reject new Drive-file creation while Drive auth is unavailable until we have
   a durable pending-upstream-creation queue.

Keep using content checksum (`md5Checksum`) as the sync/conflict predicate where
possible. Upstream revision IDs should be persisted as provenance and diagnostic
metadata, not as the only proof that two notebook payloads are equal.

## Background

[Issue 165](https://github.com/runmedev/web/issues/165) reported possible data loss around expired Drive auth. We have not
reproduced the loss, but investigation found two risky areas:

1. Local content could be overwritten by Drive content when no remote checksum
   baseline had been recorded.
2. Creating a new notebook from a Drive Explorer location while auth is expired
   can produce a browser-only local notebook instead of a Drive-backed mirror.

PR #167 added conservative Drive sync guards and logging. This document captures
follow-up work that should happen after the #157 / local-mirror cleanup.

The UI should render "is my local notebook mirror synced to its upstream?", not
"is my Google Drive file synced?".

## Proposal 1: Model Upstream Versions as Optional Metadata

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

Revision ID/version should answer "which upstream version did we last touch?"
and "what revision did this local cache come from?", but should not replace
checksum comparison.

## Proposal 2: Persist Drive Revision Provenance

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

## Proposal 3: Structured Logging for Overwrites and Revision Transitions

Use `appLogger` for sync events that are important for data-loss diagnosis.

Log before replacing local notebook JSON with upstream JSON:

```text
event: Overwriting local notebook content with upstream content
attrs:
  scope: storage.notebook.sync
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
  scope: storage.notebook.sync
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

After the Issue 157 refactor, expose sync state in terms of the local mirror and
its optional upstream. Do not expose a Google-Drive-specific status object to
notebook tabs.

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
  syncNow(localUri: string): Promise<void>;
  subscribeSync(localUri: string, listener: () => void): () => void;
}
```

`syncNow` should call the same synchronization state machine as the debounced
background sync; it should not create a second upload path.

The first implementation can omit `subscribeSync` and poll/recompute when
NotebookData emits, if that is enough for the tab indicator. Add a subscription
only when we need tabs to update immediately after metadata-only sync events.

## Proposal 6: Block Drive New-File Creation While Drive Auth Is Unavailable

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

This avoids creating an IndexedDB-only notebook when the user intended to create
a Drive-backed notebook.

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
2. Implement the Issue 157 local-mirror consolidation described in
   `20260408a_refactor_notebooks.md`.
3. Add optional `UpstreamVersion` metadata to local mirror records.
4. Adapt Drive metadata into `UpstreamVersion`.
5. Add structured appLogger events for uploads, downloads, conflicts, and
   local-overwrite.
6. Add generic `syncNow` and sync-state API on the local mirror service.
7. Add tab-level sync indicator using the sync-state API.
8. Wire red/failed indicator clicks to immediate sync or required auth/reconnect.
9. Change Explorer "new Drive file" flow to require auth before creating the
   local mirror.
10. Add tests for expired-auth new-file creation.

## Test Plan

- Create a Drive-backed notebook and verify IndexedDB records checksum,
  head revision ID, and Drive version after initial upload.
- Create a browser-only notebook and verify sync state is IndexedDB-only.
- Open/mirror a filesystem notebook and verify sync state uses `file://...`.
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
