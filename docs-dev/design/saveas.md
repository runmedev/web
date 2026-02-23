# Save As / Rename Design

## Scope

This document describes how notebook `Save As` and `Rename` should work in the
current web app architecture, with emphasis on Google Drive-backed notebooks.

The goal is to define an implementation that works with the existing:

- `NotebookData` in-memory model
- `NotebookContext` tab registry
- `CurrentDocContext` URL/document selection
- `LocalNotebooks` IndexedDB mirror for Drive files

## Summary

### Rename (same file)

`rename` should update the existing notebook record and keep the same notebook
identity.

- local/Drive-backed notebooks: `LocalNotebooks.rename(localUri, newName)`
- filesystem/contents notebooks: use the corresponding store `rename(...)`

### Save As (new file)

`save as` should create a **new notebook identity**:

1. Create a new remote file (e.g. Google Drive file)
2. Create a new local mirrored file entry (`local://file/...`) in IndexedDB
3. Save the current notebook contents into that new local entry
4. Switch the active UI document/tab to the new local URI

This is the recommended v1 implementation.

## Why This Design

The current app treats the active notebook as a **local URI** (for Drive-backed
files, this is a mirrored `local://file/...` record), not a remote Drive URI.

Important implications:

- `CurrentDocContext` stores the active doc as a local URI and derives the URL
  `?doc=` from the local record's `remoteUri`
- `NotebookContext` stores `NotebookData` instances in a map keyed by notebook
  URI
- Tabs in `Actions.tsx` are keyed by the notebook URI

Because of this, `Save As` is not just "rewrite remote target"; it changes the
document identity and should be modeled as opening a new notebook.

## Current Architecture (Relevant Pieces)

### Notebook Identity

- `NotebookData` stores `uri` and persists using `notebookStore.save(this.uri, ...)`
- `NotebookProvider` stores `NotebookData` instances in a map keyed by URI
- Open tabs are tracked as `NotebookStoreItem[]` and keyed/rendered by URI

Key files:

- `/Users/jlewi/code/runmedev/import/app/src/lib/notebookData.ts`
- `/Users/jlewi/code/runmedev/import/app/src/contexts/NotebookContext.tsx`
- `/Users/jlewi/code/runmedev/import/app/src/components/Actions/Actions.tsx`

### Drive Mirroring

Drive files are mirrored to IndexedDB through `LocalNotebooks`:

- local file record key: `local://file/<uuid>`
- remote Drive target: `LocalFileRecord.remoteId`

`CurrentDocContext` converts a remote Drive URI in the URL into a local mirror
URI via `store.addFile(doc)`.

Key files:

- `/Users/jlewi/code/runmedev/import/app/src/storage/local.ts`
- `/Users/jlewi/code/runmedev/import/app/src/contexts/CurrentDocContext.tsx`

## Recommendation

## 1) Treat Save As as "Create New Notebook + Switch Current Doc"

For Drive-backed `Save As`, do not mutate the current notebook identity in
place. Instead:

1. Create the new Drive file
2. Create a new local mirror entry for that Drive file
3. Save the current notebook content to the new local entry
4. Switch the UI to the new local URI

This preserves the current architecture and minimizes risk.

### Why not mutate in place?

- `NotebookContext` map keys are URI-based
- open tabs are URI-based
- `NotebookData.setUri(...)` updates the model field but does not re-key
  `NotebookContext`'s internal map or tab lists
- in-place URI swaps are easy to get wrong and can break tab state, autosave,
  and current-doc selection

## 2) Keep Rename and Save As Separate

These are different operations:

- `rename` changes display name (and remote name) for the same file identity
- `save as` creates a new file identity

Do not overload `rename` to perform `save as`.

## Save As Flow (Drive)

Illustrative flow for a "Save As to Google Drive" command:

1. Resolve current notebook:
   - `const nb = runme.getCurrentNotebook()`
2. Read the notebook payload:
   - `const notebook = nb.getNotebook()`
3. Create remote Drive file:
   - `const remoteUri = await drive.create(folderId, fileName)` (or store-level API)
4. Create local mirror entry for the new remote file:
   - `const newLocalUri = await localStore.addFile(remoteUri, fileName)`
5. Persist notebook to the new local entry:
   - `await localStore.save(newLocalUri, notebook)`
6. Switch current notebook in the UI:
   - `setCurrentDoc(newLocalUri)`
7. Optional:
   - close the old tab, or leave both tabs open

## IndexedDB Changes Required

### What should change

For `Save As`, create a **new** `LocalFileRecord` in IndexedDB:

- new `id` (`local://file/<uuid>`)
- `name` = new file name
- `remoteId` = new Drive file URI
- `doc` = current notebook JSON
- `lastRemoteChecksum` / `lastSynced` initialized appropriately

### What should not change (v1)

Do not rewrite the existing `LocalFileRecord.id` or "repoint" the existing
record to a different remote file as the primary implementation.

Repointing can be made to work, but it couples `Save As` to tab identity and
`NotebookContext` internals, and increases the chance of stale references.

## UI / Runtime Integration Recommendations

## 1) Add an Explicit App API for Opening/Switching Notebook

To support `Save As` from AppConsole/AppKernel cells, expose an explicit helper:

- `app.openNotebook(uri: string)` or
- `app.setCurrentNotebook(uri: string)`

This should call the same UI path used for normal notebook switching
(`setCurrentDoc(...)`), not manually mutate URL state.

## 2) Add a Higher-Level Save As Helper

Prefer a dedicated helper instead of forcing users to orchestrate multiple
calls manually:

- `drive.saveAsCurrentNotebook(folderId, fileName)` (user-facing convenience), or
- generic `files.saveAsCurrentNotebook(targetStoreUri, fileName)` (future)

For v1, a Drive-specific helper is acceptable if it uses the generic internal
pattern (create remote + local mirror + switch current doc).

## 3) Keep NotebookData Ownership Model Intact

`NotebookData` should continue to own in-memory notebook state for a single URI.
`Save As` should create/open a new notebook identity rather than mutating the
existing `NotebookData` instance to point to a new URI.

## Open Questions / Follow-ups

1. Should `Save As` close the old tab automatically?
2. Should `Save As` preserve unsaved transient UI state (selection, collapsed
   cells, active cell)?
3. Should `Save As` update the Explorer tree immediately by inserting the new
   local file into the parent folder's `children`, or rely on a folder refresh?
4. Should there be a store-level API on `LocalNotebooks` (e.g.
   `saveAsToRemote(...)`) to keep AppConsole/AppKernel helpers thin?

## Recommended v1 Implementation Plan

1. Add a UI-level helper to switch/open notebooks by local URI (`app.openNotebook`)
2. Add a Drive `save as` helper that:
   - creates remote file
   - creates local mirror entry
   - saves notebook to local mirror
   - switches current doc
3. Add tests:
   - unit test for local mirror record creation + switch behavior
   - AppKernel CUJ notebook step verifying `Save As` switches the current doc
     and subsequent save writes to the new Drive target

