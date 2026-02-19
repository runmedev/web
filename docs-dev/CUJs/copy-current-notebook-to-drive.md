# CUJ: Copy Current Notebook To Google Drive

## Goal

From the App Console, a user can copy the currently open notebook to a target location in Google Drive with one command.

## Primary User Story

1. User opens an existing notebook in the web app.
2. User opens the App Console.
3. User runs a command to copy the current notebook to Drive.
4. App reports success and returns the new Drive file identifier/URL.
5. App opens the copied notebook.

## Proposed Console Contract (v0)

```js
const source = app.getCurrentNotebook();
const target = drive.newNotebook("folder/subfolder/name.json");
const copied = await drive.copy(source, target);
await app.openNotebook(copied.uri);
```

## Semantics

- `app.getCurrentNotebook()` returns a stable notebook reference for the currently open notebook (at minimum, URI).
- `app.openNotebook(uri)` opens a notebook and makes it current.
- `drive.newNotebook(path)` resolves a destination path in Drive.
- `drive.copy(source, target)` copies notebook contents to a new Drive file.
- Copy preserves notebook cell/order/content/metadata.
- On success, return destination file id and URL/URI.
- After copy, CUJ performs open on the new notebook so it becomes current.

## Preconditions

- User is authenticated with Google Drive scope.
- A notebook is currently open.
- Destination parent path is writable.

## Happy Path Acceptance Criteria

- Command completes without errors.
- New notebook exists at requested path.
- Opened source and copied target have equivalent notebook JSON payloads.
- Console prints a confirmation message including destination id/URL.
- Copied notebook is opened and becomes current doc.

## Error Cases

- No current notebook selected:
  - Return actionable error: "No notebook is currently open."
- User not authenticated / token expired:
  - Return actionable error: "Drive authentication required."
- Destination path invalid:
  - Return actionable error with the invalid segment.
- Destination already exists:
  - v0: fail with "already exists"
  - later iteration: optional overwrite flag

## Test Plan (CUJ Validation)

- Manual browser CUJ:
  - Open notebook, run copy command, verify success output.
  - Verify copied notebook is opened and selected as current doc.
  - Open copied file and verify notebook parity.
- Automated follow-up:
  - Add a browser script under `app/test/browser/` once Drive auth in test env is stable.
