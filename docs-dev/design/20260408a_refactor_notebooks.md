# Refactor Notebook Persistence Around the Local Mirror

Date: 2026-04-08

Issue: https://github.com/runmedev/web/issues/157

## Summary

Make `runme-local-notebooks` and `LocalNotebooks` the app-facing persistence
layer for editable notebooks.

Recommended changes:

1. Use IndexedDB as the local mirror for every editable notebook.
2. Represent open notebooks in the UI as `local://file/<id>` records.
3. Keep the existing `remoteId` field, but make it a non-empty upstream URI.
4. Support three storage modes explicitly:
   - browser-only IndexedDB
   - Google Drive upstream
   - local filesystem upstream
5. Remove or demote `NotebookStore` as a UI-facing abstraction after the mirror
   path is complete.

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

## Current Interface Model

Today's relevant layers are:

- `NotebookData`: in-memory notebook model used by the editor
- `NotebookStore`: generic CRUD interface used by raw notebook stores and URI
  routing
- `LocalNotebooks`: IndexedDB-backed local/Drive mirror used for `local://`
  records
- `DriveNotebookStore`: Google Drive backend used by `LocalNotebooks`
- `FilesystemNotebookStore`: local filesystem backend with a separate IndexedDB
  handle database
- `ContentsNotebookStore`: HTTP contents backend
- `NotebookStoreContext`: React context that currently exposes
  `LocalNotebooks`, not an arbitrary `NotebookStore`

This means a generic backend abstraction exists, but the app-facing local-first
abstraction is still incomplete and storage is still split:

```text
Drive notebook -> LocalNotebooks / runme-local-notebooks -> DriveNotebookStore
Browser-only notebook -> LocalNotebooks / runme-local-notebooks
Filesystem notebook -> FilesystemNotebookStore / runme-fs-workspaces
Contents notebook -> ContentsNotebookStore
```

The target first hop should be uniform:

```text
NotebookData / UI
  -> local://file/<id>
  -> LocalNotebooks local mirror
  -> optional upstream selected by remoteId
```

## Proposal 1: Consolidate Around a Local Mirror

Use `runme-local-notebooks` as the canonical app-facing notebook store.

All open/editable notebooks should have a `local://file/<id>` identity and an
IndexedDB mirror record.

Support three backend categories explicitly:

| Backend | Meaning | `remoteId` |
| --- | --- | --- |
| IndexedDB only | browser-only notebook; no external file | `local://file/<same-id>` |
| Google Drive | Drive blob file | current `https://drive.google.com/...` URL |
| Local filesystem | file selected through File System Access API | `file://...` |

`contents://...` can follow the same upstream-backend pattern if/when we want
contents-backed notebooks to be local-first editable.

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

For filesystem-backed notebooks:

```text
id = local://file/123
remoteId = file:///absolute/path/to/notebook.json
```

Then the URI scheme selects the upstream. Empty string stops being part of the
state machine.

Do not migrate Google Drive upstream identity to a new `gdrive://` scheme as
part of this work. The existing Drive URL is already the upstream URI and keeps
sharing/copy-link behavior aligned with the user's mental model.

Migration note: backfill empty `remoteId` values to the record's local `id`,
then remove empty-string special cases.

## Proposal 3: Make LocalNotebooks the App-Facing Store

Do not add a new public `NotebookUpstreamBackend` interface yet.

First clean up the existing abstraction boundary:

- make `LocalNotebooks` the app-facing notebook store
- stop routing UI/editor save-load flows directly to filesystem, contents, or
  raw Drive stores
- mirror notebooks from Google Drive, filesystem, and IndexedDB-only records
  into `LocalNotebooks`
- delete `resolveStore(...)` / `storeForUri(...)` call paths after all open
  notebook URIs are `local://file/<id>`
- then evaluate whether the remaining raw-backend code needs a formal
  interface

In this target shape, `LocalNotebooks` owns IndexedDB records, checksum
comparison, sync scheduling, conflict handling, and local recovery policy.
Drive/filesystem/contents code is an implementation detail behind
`LocalNotebooks`, selected by the URI stored in `remoteId`.

This should let us remove or demote the current `NotebookStore` interface as a
UI-facing concept. We may still keep shared data types such as
`NotebookStoreItem` or replace them with clearer local-mirror metadata types.

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

## Migration Plan

1. Add a migration/backfill so every `LocalFileRecord` has a non-empty
   `remoteId`.
2. Update local-only create paths to set `remoteId = id` instead of `""`.
3. Update Drive mirror paths to keep setting `remoteId = Drive URL`.
4. Add filesystem mirror/import path:
   - create a `local://file/<id>` record
   - set `remoteId = file://...`
   - store file contents in `doc`
   - store content checksum in `md5Checksum`
5. Change `NotebookContext` / editor load/save to operate on local URIs.
6. Remove `resolveStore(...)` from the notebook tab/editor load path.
7. Change Explorer open-file behavior so fs/contents entries are mirrored
   before opening an editor tab.
8. Remove or shrink `runme-fs-workspaces` once local filesystem mirrors live in
   `runme-local-notebooks`.
9. Revisit `NotebookStore`; delete it if it is no longer pulling its weight, or
   keep it as a private raw-backend helper.

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
  first; filesystem write happens through the mirror sync path.
- Reload the app and verify open notebooks restore from local URIs.

## Open Questions

- Do we mirror `contents://...` in the first refactor, or defer it until Drive
  and filesystem use the same mirror path?
- Do folders get the same `remoteId = id` invariant as files, or does the first
  pass focus only on file records?
- Should `remoteId` eventually be renamed in code, or is documenting it as
  "upstream URI" sufficient?
