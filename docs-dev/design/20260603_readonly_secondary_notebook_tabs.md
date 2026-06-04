# Read-Only Secondary Notebook Tabs

Date: 2026-06-03

## Summary

Allow a notebook that is already owned by another browser tab to open as a
read-only notebook in the current tab.

The ownership lock remains the write authority. The owner tab can edit and run
the notebook. Secondary tabs can load and inspect the notebook, including from
AppKernel helpers, but cannot mutate cells, outputs, metadata, names, or backing
storage.

## Current State

`NotebookDataController.openNotebook()` resolves a requested URI to the stable
`local://file/...` URI and then asks `NotebookOwnershipManager` for an exclusive
lease.

Before this change, a blocked lease produced an `OpenNotebookEntry` with
`state: "blocked"` and no `NotebookData` model. That protected the document from
concurrent writes, but it also prevented useful read scenarios:

- using one notebook as reference while writing another notebook
- letting Codex read a reference notebook while updating the active notebook

The existing write protections are still the right boundary:

- Web Locks decide which tab owns writes.
- `NotebookData` persists through a store wrapper that checks the active lease.
- AppKernel notebook resolution previously exposed only owned notebooks.

## Decision

Blocked ownership becomes read-only access, not a blocked view.

When `NotebookOwnershipManager.acquire(localUri)` returns `blocked`,
`NotebookDataController` will:

1. create or reuse a `NotebookData` model for `localUri`
2. mark it `readOnly`
3. load notebook content from `LocalNotebooks`
4. publish an open entry with `state: "loaded"` and `readOnly: true`
5. keep owner metadata for UI explanation

Unsupported Web Locks still fail closed. If the browser cannot safely determine
ownership, the app must not open an editable or read-only notebook under the
multi-tab ownership model.

## Read-Only Contract

`OpenNotebookEntry` and `NotebookSnapshot` carry `readOnly`.

`NotebookData` owns the local enforcement:

- read-only notebooks have no save store
- `updateCell`, `appendCell`, `addCellBefore`, `addCellAfter`, `removeCell`,
  `setName`, `setUri`, and `runCodeCell` throw
- persistence is skipped when `readOnly` is true
- `loadNotebook(..., { persist: false })` remains allowed so the read-only view
  can hydrate from storage

Runtime APIs expose read-only notebooks for reads:

- `notebooks.list()` includes read-only notebooks with `readOnly: true`
- `notebooks.get()` returns a cloned notebook document so callers cannot mutate
  the live model by editing the returned object

Runtime APIs reject read-only mutations:

- `notebooks.update`
- `notebooks.delete`
- `notebooks.execute`
- `runme.clear`
- `runme.runAll`
- `runme.rerun`

This lets Codex inspect another open notebook through AppKernel while preventing
Codex from changing it.

## UI Contract

The tab strip shows a lock icon for read-only notebooks. Hovering the icon shows
that the notebook is read-only because it is open for editing in another browser
tab.

The notebook pane also shows a read-only banner. This keeps the mode visible
after the user starts reading the document and no longer looks at the tab title.

Editing controls are disabled or hidden:

- code, markdown, and HTML editors are read-only
- add-cell buttons are disabled or hidden
- delete buttons are disabled
- run buttons are disabled
- language, runner, and kernel selectors are disabled
- markdown and HTML rendered views do not switch into edit mode
- tab rename is disabled

The sidebar open-documents list labels read-only notebooks as `Read-only`.

## Tradeoffs

Read-only views read from the local notebook mirror. They do not subscribe to
live in-memory edits from the owner tab. This keeps the change scoped and avoids
introducing cross-tab document synchronization.

The read-only view may therefore be stale until the owner tab persists changes
and the secondary tab reloads or reopens the notebook. That is acceptable for
this change because the goal is safe reference access, not collaborative live
editing.

## Open Question

Should read-only tabs auto-refresh when the owner tab saves?

The current implementation does not add a refresh protocol. A future change
could use the existing tab-coordination channel to notify read-only tabs that a
new local mirror version is available, then offer a manual refresh action or
safe auto-refresh when the user has no local selection state to preserve.
