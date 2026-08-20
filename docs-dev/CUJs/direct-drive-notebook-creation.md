# CUJ: Direct Google Drive Notebook Creation

## Goal

Create one new notebook whose authoritative file is in Google Drive without
first creating a standalone local notebook or using Save As.

## Automated path

`app/test/browser/test-scenario-open-shared-drive-link.ts` configures the Go
fake Drive backend, mounts its shared folder, and runs this App Console command:

```js
await drive.createNotebook(
  "https://drive.google.com/drive/folders/shared-folder-123",
  "direct-cuj.json",
  {
    idempotencyKey: "direct-drive-cuj",
    cells: [{ kind: "markup", value: "# Created directly in Drive" }],
  },
)
```

The App Console exercises the same domain function used by the dedicated
`createDriveNotebook` WebMCP tool.

## Acceptance criteria

- Drive reserves an ID and creates `direct-cuj.json` in the requested folder.
- The result contains a Drive URI and an editable `local://` mirror URI.
- Explorer shows exactly one `direct-cuj.json` child in the mounted folder.
- The local entry is a mirror of the Drive file, not a second standalone
  notebook.
- Reusing the idempotency key for a retry resolves to the same Drive file.

## Artifacts

- `scenario-open-shared-drive-link-08-direct-create.txt`
- `scenario-open-shared-drive-link-08-direct-create.png`
- the shared Drive link walkthrough video
