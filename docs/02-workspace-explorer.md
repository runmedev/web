---
name: workspace-explorer
title: Workspace Explorer
order: 2
description: >-
  Use this guide to understand how the workspace explorer presents and
  navigates local notebooks, mounted filesystem directories, and Google Drive
  content. It covers common explorer actions, programmatic entry points, and
  selection or refresh behavior. Use the storage-specific guides when the task
  is mounting a directory, configuring Drive, or recovering browser-local data.
---

# Workspace Explorer

## Purpose

The explorer is the user-facing file and notebook navigation surface.

It can show:

- local notebook folders,
- filesystem workspaces,
- Drive-backed folders and files,
- synthetic status items used for link or sync workflows.

## Common user actions

- mount a local folder,
- mount a Drive link,
- import markdown as a notebook,
- open a notebook,
- create a concurrent Runme (`.runme`), Runme JSON, or Jupyter (`.ipynb`)
  notebook in a folder,
- rename a notebook,
- remove a mounted folder,
- copy a notebook share link.

## Canonical App Console entry points

```js
explorer.help()
explorer.addFolder()
explorer.openPicker()
explorer.importMarkdown()
explorer.mountDrive('https://drive.google.com/...')
explorer.listFolders()
await explorer.sync()
explorer.removeFolder(uri)
```

## Explorer behavior details

- `Local Notebooks` is always expected as a baseline workspace root.
- Folder expansion is lazy; children are fetched when the folder opens.
- Drive links may enqueue coordination work before a notebook becomes editable.

## Key facts

- Opening a file from the explorer is the safest way to make it the current document.
- Removing a folder from the explorer does not necessarily delete its upstream source.
- Explorer items may have local URIs and separate `remoteUri` values.
- The filename extension selects the notebook format: `.runme` for the
  append-only Runme operation log, `.json` for Runme JSON, and `.ipynb` for
  Jupyter.
- Each open `.runme` tab keeps its own materialized snapshot. Use the notebook
  banner or `notebooks.refresh({ target: { uri } })` to incorporate operations
  appended by other sessions.
- `.runme` cell edits, executions, and comment-thread lifecycle changes are
  appended as operations; the editor and `comments.*` APIs materialize them.

## Refreshing folder contents

Folder listings refresh every minute while Runme is open in a visible, online
browser tab, including when another sidebar panel is selected. Mounted roots
and expanded folders are refreshed; collapsed descendants are loaded when opened.
This updates names and folder membership without downloading or overwriting
notebook contents. Browser background throttling can delay a refresh.

Tap **Sync folders** (the circular arrow at the top right, immediately left of
**Open local folder**) for an immediate refresh. This also works on phones without
a context menu. The button spins and is disabled during the refresh. If a folder
fails, its previous listing remains available and the panel shows a retry message;
other folders can still update. Reconnect Drive or grant local folder access
through the existing controls if needed; background sync never opens an auth prompt.

The same action is available in App Console, browser JavaScript cells and
WebMCP/code mode as `await explorer.sync()`. It returns `{ refreshed, failed }`
with folder URIs. Repeated requests share the current refresh pass.
