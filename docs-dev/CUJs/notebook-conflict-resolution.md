# CUJ: Notebook Conflict Resolution

## Goal

A user can review a Google Drive sync conflict, insert cells that exist only in
the upstream version, and save the resolved local notebook back to Drive.

The same resolution behavior must be available in two ways:

- by clicking controls in the notebook diff tab,
- by running App Console / WebMCP commands through `notebookDiff`.

## Preconditions

- The app is running locally.
- Google Drive is authorized.
- For local testing with a service account, configure the app with:

```js
await credentials.google.setServiceAccountFromFilePath(
  '/Users/jlewi/secrets/aisre-gdrive-oai-test-8ba1a40f228e.json'
)
await drive.authorize()
```

- The service account can write to:
  `https://drive.google.com/drive/folders/0AMdUS1hL9Av2Uk9PVA`

## Creating A Conflict

Use two browser tabs or two app sessions against the same Drive-backed notebook.

1. Create a Drive notebook in the test folder.
2. Open the notebook in the app and let it sync.
3. In session A, delete a cell locally and keep the notebook open.
4. In session B or through a direct Drive update, edit the upstream copy so that
   its checksum changes while the deleted cell still exists upstream.
5. Return to session A and trigger Drive sync.
6. The notebook tab should enter `conflicted` sync state instead of overwriting
   either side.

The key invariant is:

```text
last synced upstream checksum = A
current local checksum        = B
current upstream checksum     = C

B != A and C != A
```

For a deterministic browser test, the upstream mutation should preserve the cell
that session A deleted and change another cell or metadata field. That creates a
diff with a deleted upstream cell that can be restored into the local notebook.

## Manual UI Flow

1. Click the conflicted notebook tab sync indicator.
2. Verify a notebook diff tab opens.
3. Find a cell marked as present in upstream and deleted locally.
4. Click **Insert ->** on that deleted-cell row.
5. Verify the cell appears in the local notebook in the expected order.
6. Click **Save local version**.
7. Verify the notebook tab returns to a non-conflicted sync state.
8. Reopen the Drive file or reload the app and verify the restored cell remains.

## App Console / WebMCP Flow

The conflict actions are available through `notebookDiff`:

```js
const doc = await notebooks.get()
const conflicts = await notebookDiff.listConflictCells({
  target: { handle: doc.handle },
})
console.table(conflicts)

await notebookDiff.restoreAllDeletedCells({
  target: { handle: doc.handle },
})
```

For a single upstream-only cell:

```js
await notebookDiff.restoreDeletedCell({
  target: { handle: doc.handle },
  refId: 'upstream-cell-ref-id',
})
```

To open the same conflict diff tab that the UI opens:

```js
await notebookDiff.openConflictDiff({
  target: { handle: doc.handle },
})
```

These commands use the same restore implementation as the **Insert ->** button.
They flush pending local notebook edits before saving so recent debounced edits
are preserved.

## Acceptance Criteria

- Conflict detection preserves both local and upstream versions.
- The conflict diff shows upstream-only cells as deleted from the local copy.
- **Insert ->** restores a deleted upstream cell into the local notebook.
- `notebookDiff.restoreDeletedCell(...)` restores the same cell without using
  the mouse.
- `notebookDiff.restoreAllDeletedCells(...)` restores every remaining
  upstream-only cell.
- Restored cells keep stable ordering:
  - nearest surviving upstream neighbor first,
  - timestamp fallback second,
  - bounded upstream index fallback last.
- Saving the local version clears conflict metadata and writes the resolved
  notebook to the original Drive file.
- A browser CUJ artifact includes a short video showing conflict review,
  programmatic or UI restoration, and final save.

## Test Notes

- Prefer machine-verifiable checks:
  - visible `conflicted` state before resolution,
  - `notebookDiff.listConflictCells(...)` contains the deleted upstream ref id,
  - `notebookDiff.restoreAllDeletedCells(...)` returns a notebook whose cell ids
    include the restored upstream refs,
  - post-save sync state is no longer `conflicted`.
- Keep the Drive test file in the service-account writable folder.
- Use unique filenames with a timestamp or run id so repeated CUJ runs do not
  collide.

## Demo Artifact

- Movie: `docs-dev/assets/conflict-resolution-demo/conflict-resolution-demo.mp4`
- The recorded Drive-backed run created
  `conflict-resolution-scroll-20260613215751.json` in the shared
  service-account test folder. The movie scrolls through the full conflict diff
  before resolution, restores three upstream-only cells through WebMCP, then
  scrolls through the resolved local notebook down to the final cells.
