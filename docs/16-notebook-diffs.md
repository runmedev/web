# Notebook Diffs

Runme can compute and render a notebook-aware diff between the local copy of a
Google Drive-backed notebook and an available Google Drive revision.

This is a code-centric V0. Use a browser JavaScript cell in the notebook to
inspect revisions, compute the diff, and open the rendered diff view.

## Requirements

- The current notebook must be backed by a Google Drive file.
- The browser OAuth credential must have access to read the Drive file and its
  revision contents.
- The revision must still be available from Google Drive. Drive does not
  guarantee complete history for every blob revision.

## List Available Drive Revisions

Run this in a JavaScript cell using the AppKernel browser runner:

```js
const revisions = await notebookDiff.listDriveRevisions();

console.table(
  revisions.map((revision) => ({
    id: revision.id,
    modifiedTime: revision.modifiedTime,
    md5Checksum: revision.md5Checksum,
    size: revision.size,
    lastModifyingUser: revision.lastModifyingUser?.emailAddress,
  })),
);
```

The returned revision ids are Google Drive `Revision` ids for the notebook file.

## Compute and Open a Diff

Choose one of the returned revision ids, then run:

```js
const revisionId = revisions.at(-2)?.id;

if (!revisionId) {
  throw new Error("No earlier Drive revision is available.");
}

const diff = await notebookDiff.diffDriveRevision({
  revisionId,
  includeOutputs: true,
  includeMetadata: true,
});

await notebookDiff.openDiffTab(diff);
```

The diff view compares:

- left column: the selected Drive revision,
- right column: the current local notebook copy.

The renderer shows inserted, deleted, modified, moved, and unchanged cells.
Unchanged cells are collapsed by default. Output changes are indicated by
default, with large output bodies folded so source changes remain readable.

## Target A Specific Open Notebook

When multiple notebooks are open, pass a notebook target explicitly:

```js
const doc = await notebooks.get();
const revisions = await notebookDiff.listDriveRevisions({
  handle: doc.handle,
});

const diff = await notebookDiff.diffDriveRevision({
  target: { handle: doc.handle },
  revisionId: revisions.at(-2).id,
});

await notebookDiff.openDiffTab(diff);
```

## Notes

- V0 supports Runme notebooks only.
- Markdown cells are rendered as source diffs.
- Output-only changes count as real differences.
- V0 does not merge outputs. Conflict-resolution flows should clear outputs for
  cells touched by resolution and let users rerun cells.

