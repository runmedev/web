---
runme:
  id: drive-manual-smoke
  version: v3
---
# Google Drive Manual Smoke (AppConsole Cells)

This notebook is a manual smoke test for Google Drive helpers exposed to notebook
`appconsole` cells.

## Preconditions

- You are signed in and have a valid Google Drive token.
- `googleDrive.clientID` is configured (typically via `/configs/app-configs.yaml`).
- You have a writable Drive folder ID for testing.

## Helpers

```appconsole {"name":"helpers"}
console.log(help());
```

## Auth Status

```appconsole {"name":"auth-status"}
const status = await oidc.getStatus();
console.log(JSON.stringify(status, null, 2));
```

## Notebook Context

```appconsole {"name":"current-notebook"}
const current = app.getCurrentNotebook();
console.log(current ? { uri: current.getUri(), name: current.getName() } : null);
```

## Configure Target Folder

Replace the placeholder with a real writable Drive folder ID (or Drive folder URL).

```appconsole {"name":"set-drive-folder"}
globalThis.TEST_DRIVE_FOLDER = "REPLACE_WITH_DRIVE_FOLDER_ID";
console.log("TEST_DRIVE_FOLDER =", globalThis.TEST_DRIVE_FOLDER);
```

## Create + Update File

```appconsole {"name":"drive-create-update"}
if (!globalThis.TEST_DRIVE_FOLDER || globalThis.TEST_DRIVE_FOLDER.includes("REPLACE_WITH")) {
  throw new Error("Set globalThis.TEST_DRIVE_FOLDER first.");
}

const fileName = `runme-drive-manual-${Date.now()}.md`;
const fileId = await drive.create(globalThis.TEST_DRIVE_FOLDER, fileName);
const body = `# Drive Manual Smoke\n\nCreated: ${new Date().toISOString()}\n`;
await drive.update(fileId, new TextEncoder().encode(body), "text/markdown");

console.log({ fileId, fileName });
console.log(`https://drive.google.com/file/d/${fileId}/view`);
```

## Notes

- This validates the current browser-side Drive path used by the app (including
  auth token use and Drive writes).
- As copy/open helpers are implemented, add follow-up cells here to validate the
  full CUJ.
