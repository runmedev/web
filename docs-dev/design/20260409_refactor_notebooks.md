# Refactor Notebook Persistence Around the Local Mirror

Date: 2026-04-08

Issue: https://github.com/runmedev/web/issues/157

## Summary

Make `runme-local-notebooks` and `LocalNotebooks` the app-facing persistence
layer for editable notebooks. Raw upstream stores are still useful for browsing
and one-time imports, but editor tabs should save/load through the local mirror.

Status in PR #168:

1. Done: use `LocalNotebooks` / IndexedDB as the local mirror for editable
   browser-only, Google Drive, and File System Access notebooks.
2. Done: when an `fs://...` file is opened, `NotebookContext` mirrors it and
   switches the editor tab to `local://file/<id>`.
3. Done for files: keep `remoteId`, but backfill empty values and treat it as a
   non-empty upstream URI. Browser-only notebooks use `remoteId === id`.
4. Done: remove the old `NotebookStore` CRUD/routing interface.
5. Done: introduce `StorageBrowser`, the narrow browse/mutate interface used by
   `WorkspaceExplorer` for workspace trees.
6. Deferred: migrate/delete `runme-fs-workspaces`. It still stores persisted
   File System Access handles for workspace roots.
7. Done: remove the web-side `ContentsNotebookStore`. Investigation found that
   the matching runme backend service was intentionally not implemented.

## Background

Runme already uses IndexedDB as a local mirror for Google Drive notebooks. For
Drive-backed notebooks the local record stores:

- local notebook JSON
- a Drive file URI in `remoteId`
- the last Drive content checksum we observed
- a local content checksum
- the last successful sync timestamp

[Issue 157](https://github.com/runmedev/web/issues/157) proposes consolidating
notebook storage: use `runme-local-notebooks` as the canonical local mirror, and
treat local filesystem plus `contents://` as upstream backends, just like Drive.
When the refactor is complete, `runme-fs-workspaces` should be removed.

Important contents-service correction: the `contents://` idea was superseded by
the File System Access API plan in
[runmedev/runme#1025](https://github.com/runmedev/runme/issues/1025). A local
runme checkout contains no `runme.contents.v1` proto, generated code, server
handler, or route registration. Do not carry contents support forward unless a
real backend and product entry point are added.

## History: How the Abstraction Drift Happened

The original storage shape was direct-to-backend:

```text
UI / NotebookData -> NotebookStore -> Google Drive
```

At that point `NotebookStore` made sense as a common CRUD interface. The UI
could call `load/save/list/create/rename/getMetadata` on whichever backend
owned the URI.

We then changed the Google Drive design to be local-first:

```text
UI / NotebookData
  -> local://file/<id>
  -> LocalNotebooks / IndexedDB
  -> DriveNotebookStore / Google Drive
```

After that shift, `LocalNotebooks` became the app-facing store for browser-only
and Drive-backed notebooks. Google Drive became an upstream sync target, not the
identity opened in editor tabs.

The drift happened because later File System Access support reused the old
`NotebookStore` direct-backend pattern instead of joining the local-mirror
pattern. Web also accumulated an experimental contents-service client even
though the corresponding runme backend was not built:

```text
Filesystem notebook -> FilesystemNotebookStore / runme-fs-workspaces
Contents notebook -> ContentsNotebookStore -> unimplemented runme.contents.v1 service
```

The result is two competing abstractions:

- `LocalNotebooks`: local-first mirror and sync owner
- `NotebookStore`: direct CRUD interface plus URI router target

The cleanup in this doc is to finish the design shift: make `LocalNotebooks`
the single app-facing notebook store, treat Drive/filesystem as upstreams,
delete contents-service dead code, and remove the old `NotebookStore` routing
layer.

## Current Interface Model

Today's relevant layers are:

- `NotebookData`: in-memory notebook model used by the editor
- `LocalNotebooks`: app-facing IndexedDB mirror used for editor
  load/save/autosave
- `StorageBrowser`: narrow explorer interface for listing workspace trees and
  creating/renaming files in the tree
- `DriveNotebookStore`: Google Drive backend used by `LocalNotebooks` and Drive
  picker/import flows
- `FilesystemNotebookStore`: local filesystem backend with a separate IndexedDB
  handle database; it implements enough of `StorageBrowser` to browse selected
  workspace roots
- `NotebookStoreContext`: legacy-named React context that exposes
  `LocalNotebooks`, not an arbitrary store

The app-facing notebook path is now local-first:

```text
NotebookData / editor tab
  -> local://file/<id>
  -> LocalNotebooks / runme-local-notebooks
  -> optional upstream selected from LocalFileRecord.remoteId
```

The workspace explorer still has a separate browsing path:

```text
WorkspaceExplorer
  -> StorageBrowser
  -> LocalNotebooks | FilesystemNotebookStore
```

That split is intentional. The explorer must be able to list upstream folders
before any notebook has been opened/mirrored. The editor should not load or
save directly through those upstream browser adapters.

When a filesystem file is opened:

```text
fs://... selected in explorer
  -> NotebookContext loads once from the upstream store
  -> LocalNotebooks.addNotebook(upstreamUri, name, notebook)
  -> current/open document changes to local://file/<id>
```

## Proposal 1: Consolidate Around a Local Mirror

Use `runme-local-notebooks` as the canonical app-facing notebook store.

All open/editable notebooks should have a `local://file/<id>` identity and an
IndexedDB mirror record.

Support upstream categories explicitly:

| Backend | Meaning | `remoteId` |
| --- | --- | --- |
| IndexedDB only | browser-only notebook; no external file | `local://file/<same-id>` |
| Google Drive | Drive blob file | current `https://drive.google.com/...` URL |
| File System Access | browser handle-backed file | current `fs://workspace/.../file/...` URI |

Use the canonical app URI for the upstream resource. For Drive this is the
shareable `https://drive.google.com/...` URL. For File System Access this is
currently the handle-backed `fs://...` URI; browsers do not expose a stable
absolute OS path.

## Proposal 2: Make `remoteId` an Explicit Upstream URI

Today `LocalFileRecord.remoteId === ""` means "this notebook has no Drive
remote". That made it easy to conflate "browser-only notebook" with "we failed
to attach the remote after creating a file from a Drive folder."

Keep the existing `remoteId` field name, but change its invariant: `remoteId`
is the upstream URI and must be non-empty for file records.

Illustrative shape:

```ts
interface LocalFileRecord {
  id: string;          // local://file/<uuid>
  remoteId: string;    // local://file/<uuid> | file://... | https://drive...
  doc: string;
  md5Checksum: string;
}
```

For browser-only IndexedDB notebooks:

```text
id = local://file/123
remoteId = local://file/123
```

For Drive-backed notebooks:

```text
id = local://file/123
remoteId = https://drive.google.com/file/d/<drive-id>/view
```

For File System Access-backed notebooks:

```text
id = local://file/123
remoteId = fs://workspace/<workspace-id>/file/<path>
```

Then the URI scheme selects the upstream. Empty string stops being part of the
state machine.

Use the canonical URI for the upstream resource. For a Google Drive file, that
is the existing `https://drive.google.com/...` URL. Backend selection should be
derived by parsing the URI in `remoteId`; do not invent a replacement URI scheme
when the upstream system already has a canonical URI.

Migration note: PR #168 backfills empty file `remoteId` values to the record's
local `id`. Drive-only sync predicates must parse for actual Drive URL forms;
they must not treat arbitrary URI strings as Drive IDs.

## Proposal 3: Make LocalNotebooks the App-Facing Store and Remove NotebookStore

First clean up the existing abstraction boundary:

- make `LocalNotebooks` the app-facing notebook store
- stop routing UI/editor save-load flows directly to filesystem or raw Drive
  stores
- mirror notebooks from Google Drive, filesystem, and IndexedDB-only records
  into `LocalNotebooks`
- delete `resolveStore(...)` / `storeForUri(...)` call paths after all open
  notebook URIs are `local://file/<id>`
- delete the `NotebookStore` interface after the UI/editor no longer uses
  URI-based store routing

In this target shape, `LocalNotebooks` owns IndexedDB records, checksum
comparison, sync scheduling, conflict handling, and local recovery policy.
Drive/filesystem code is an implementation detail behind `LocalNotebooks`,
selected by the URI stored in `remoteId`.

PR #168 removes the old `NotebookStore` CRUD interface rather than preserving
it as a parallel abstraction. We still keep shared metadata types such as
`NotebookStoreItem`; they can be renamed in a later cleanup if a clearer
explorer/file-tree name emerges.

Keep `NotebookSaveStore` if it remains useful. It is the narrow autosave seam
that `NotebookData` calls, and it does not route among storage backends.

## Proposal 3a: Keep Workspace Browsing Narrow

Use the `StorageBrowser` interface for the workspace tree only:

```ts
interface StorageBrowser {
  list(uri: string): Promise<NotebookStoreItem[]>;
  getMetadata(uri: string): Promise<NotebookStoreItem | null>;
  create(parentUri: string, name: string): Promise<NotebookStoreItem>;
  rename(uri: string, name: string): Promise<NotebookStoreItem>;
}
```

This answers a different question from `LocalNotebooks`: "can
WorkspaceExplorer render and mutate this folder tree?"

The interface intentionally excludes notebook content load/save. File contents
are mirrored through `LocalNotebooks` before the editor opens them.

## Proposal 4: Treat Browser-Only IndexedDB as a First-Class Backend

Do not treat browser-only notebooks as "missing remote".

Browser-only notebooks should use:

```text
id = local://file/<uuid>
remoteId = local://file/<uuid>
```

`remoteId === id` means "the local mirror is the authoritative store."

This state should have explicit UI affordance, for example a gray sync indicator
with tooltip "Stored only in this browser."

## Implementation and Migration Plan

1. Done: add a migration/backfill so every `LocalFileRecord` has a non-empty
   `remoteId`.
2. Done: update local-only create paths to set `remoteId = id` instead of
   `""`.
3. Done: update Drive mirror paths to keep setting `remoteId = Drive URL`.
4. Done: add filesystem mirror/import path:
   - create a `local://file/<id>` record
   - set `remoteId = fs://...`
   - store file contents in `doc`
   - store content checksum in `md5Checksum`
5. Done: remove the contents-service mirror/import path.
6. Done: change `NotebookContext` / editor load/save to operate on local URIs.
7. Done: remove `resolveStore(...)` from the notebook tab/editor load path.
8. Done: change Explorer open-file behavior so fs entries are mirrored before
   opening an editor tab.
9. Done: delete the `NotebookStore` interface and stop typing raw backend
   classes as generic notebook stores.
10. Done: add `StorageBrowser` as the workspace explorer's narrow storage
   contract.
11. Deferred: migrate existing `runme-fs-workspaces` entries into
   `runme-local-notebooks` or provide a reconnect/import path.
12. Deferred: delete the `runme-fs-workspaces` IndexedDB database and
   associated registry code after the migration/reconnect path is in place.

## Data Migration and Compatibility

There are two existing browser-side databases to account for:

```text
runme-local-notebooks
runme-fs-workspaces
```

The migration should be incremental and compatible with users who already have
local-only, Drive-backed, and filesystem-backed notebooks.

### `runme-local-notebooks`

Add a Dexie schema migration for the `files` table.

For each `LocalFileRecord`:

1. Ensure `md5Checksum` exists, preserving the existing lazy-backfill behavior.
2. If `remoteId` is a non-empty string, keep it as-is.
3. If `remoteId` is missing or empty, set `remoteId = id`.
4. Preserve `doc`, `name`, `lastRemoteChecksum`, `lastSynced`, and
   `markdownUri`.

This makes existing browser-only notebooks explicit without changing their
local identity.

### `runme-fs-workspaces`

`runme-fs-workspaces` remains in PR #168. It is no longer the editor's
persistence store for notebook content after a file has been opened, but it
still stores browser `FileSystemDirectoryHandle` and `FileSystemFileHandle`
objects for workspace browsing.

Current mirror target for each notebook file opened from a File System Access
workspace:

```text
LocalFileRecord.id = local://file/<new uuid>
LocalFileRecord.remoteId = fs://workspace/<workspace-id>/file/<path>
LocalFileRecord.doc = latest readable JSON
LocalFileRecord.md5Checksum = md5(doc)
```

Because the File System Access API does not expose absolute OS paths, keep the
existing `fs://...` upstream URI for now. Do not invent `file://...` unless we
have an actual canonical path for the resource.

Do not delete `runme-fs-workspaces` until:

- existing workspace roots can either be imported into `runme-local-notebooks`
  or shown as "reconnect required"
- open notebook tabs that used `fs://workspace/...` restore to their mirrored
  `local://file/<id>` records
- users have a recoverable path if a persisted File System Access handle no
  longer has permission

After that compatibility path ships, delete the `runme-fs-workspaces` database
and its registry code.

### Contents Service

Remove contents-service storage code from the web app.

Findings:

- `app/src/storage/contents.ts` is a custom HTTP client for
  `/runme.contents.v1.ContentsService/{List,Read,Write,Rename,Stat}`.
- A local runme checkout does not define or generate a `runme.contents.v1`
  service.
- A local runme checkout does not register a matching HTTP/Connect handler.
- `runmedev/runme#1025` explicitly changed direction: use the browser File
  System Access API for local files and keep the Go backend focused on
  execution / parser services.
- The current web UI has no discoverable "connect contents workspace" action.

Conclusion: contents-service support was dead-end code in this repo. PR #168
deletes the web client/context/routing/tests. Do not add it back unless we
revive the backend service and add a product entry point.

## Test Plan

- Create a browser-only notebook and verify `remoteId === id`.
- Mirror a Drive notebook and verify:
  - open tab URI is `local://file/<id>`
  - `remoteId` is the Drive HTTPS URL
  - local `doc` is populated
- Mirror a filesystem notebook and verify:
  - open tab URI is `local://file/<id>`
  - `remoteId` is a `file://...` URI
  - local `doc` is populated
- Save edits to browser-only notebook and verify only IndexedDB changes.
- Save edits to Drive-backed notebook and verify local mirror changes first;
  upload happens through the mirror sync path.
- Save edits to filesystem-backed notebook and verify local mirror changes
  first; filesystem write-back uses the upstream URI recorded in `remoteId`.
- Reload the app and verify open notebooks restore from local URIs.
- Verify `WorkspaceExplorer` can still browse `fs://...` folder roots through
  `StorageBrowser`.
- Verify stale `contents://...` current/open/workspace entries are ignored or
  removed without creating new editor tabs.

## Open Questions

- Do folders get the same `remoteId = id` invariant as files? PR #168 focuses
  the required non-empty upstream invariant on file records.
- Should `NotebookStoreContext` be renamed now that it exposes
  `LocalNotebooks`, or should that wait for a broader React context cleanup?
