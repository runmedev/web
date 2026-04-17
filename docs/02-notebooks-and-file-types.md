# Notebooks And File Types

## Supported notebook concepts

The app works with notebook documents containing ordered cells.

Primary cell kinds:

- code cells,
- markdown or markup cells.

## Common source formats

- `.json` notebooks stored locally, in filesystem workspaces, or mirrored from Drive,
- `.runme.md` and other markdown documents imported into notebook form.

## Important storage distinction

The editor does not work directly against arbitrary upstream files.
Instead, the app usually opens a local working copy or local mirror and tracks
the relationship back to the upstream source.

## URI patterns worth recognizing

- `local://...`: browser-local notebook or local mirror entry,
- `fs://...`: notebook discovered through the File System Access API,
- Drive links and Drive-derived remote URIs are normalized into local entries for editing.

## What Codex should assume

- A notebook opened in the editor is generally safe to treat as mutable.
- Imported markdown becomes a notebook object, not a live markdown editor view.
- The current notebook is tracked separately from the explorer tree and URL in
  some flows.

## Practical implications

- If a user says "open this Drive file," the resulting editor document may be a
  local mirrored notebook.
- If a user says "import markdown," expect a new local notebook to be created.
- If a user says "save to Drive," that may change the active local notebook URI
  or attach new upstream sync metadata.
