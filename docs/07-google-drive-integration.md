# Google Drive Integration

## Purpose

Google Drive provides:

- notebook storage,
- folder browsing,
- link opening and sharing,
- upstream sync for Drive-backed notebooks.

## Key model

The editor usually works through a local mirror even for Drive-backed files.
That is intentional.

Benefits:

- local editing remains responsive,
- sync can resume after auth or connectivity recovery,
- the UI can surface pending or error states explicitly.

## Common user actions

- authenticate Drive access,
- mount a Drive link or folder,
- open a Drive notebook,
- save the current notebook to Drive,
- copy a notebook into another Drive folder,
- inspect or requeue pending sync.

## Useful App Console commands

```js
drive.help()
drive.list(folderIdOrUri)
drive.create(folderIdOrUri, "name.json")
drive.saveAsCurrentNotebook(folderIdOrUri, "name.json")
drive.copyNotebook(sourceIdOrUri, targetFolderIdOrUri, "name.json")
drive.listPendingSync()
drive.requeuePendingSync()
```

## High-value facts for Codex

- Drive auth and OIDC auth are related but not identical flows.
- A Drive-backed notebook may be healthy locally while upstream sync is blocked.
- For user support, the sync state is often more important than the raw Drive API call.
