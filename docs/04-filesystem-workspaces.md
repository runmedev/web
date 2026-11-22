---
name: filesystem-workspaces
title: Filesystem Workspaces
order: 4
description: >-
  Use this guide when mounting or working with a local directory through the
  browser File System Access API. It covers browser and permission
  prerequisites, the canonical mount flow, expected persistence, and important
  limitations. For browser-local notebooks that are not backed by a directory,
  use the local notebooks and browser storage guide.
---

# Filesystem Workspaces

## Purpose

Filesystem workspaces let the app mount a local directory through the browser's
File System Access API.

## Preconditions

- the browser must support the File System Access API,
- the user must grant directory permission,
- the mounted workspace remains permission-sensitive across sessions.

## Canonical flow

```js
explorer.addFolder()
```

This opens the system directory picker and mounts the chosen folder as an
`fs://...` workspace.

## Edit without Google Drive

Choose **Open local folder** in the explorer and grant read/write access. Open a
`.runme`, `.json`, or `.ipynb` file to create its browser mirror. Runme saves
edits there first. While the app runs, the storage worker checks previously
opened notebooks in mounted folders every two minutes, even after you close a
notebook tab. A filesystem mount works offline without a Drive OAuth client.

Runme merges operations in matching `.runme` files. For JSON and Jupyter
notebooks, changes on both sides can require manual resolution. The notebook
sync indicator shows errors and lets you retry. Use **Reconnect folder** from
the mounted root's context menu if access expires. Removing a mount leaves the
files on disk and retains mirrored notebooks under **Browser drafts**.

## Download and open a snapshot

Choose **Download notebook** from the notebook tab's context menu. Use **Open
file** to import the download as an independent browser draft. This works even
without a directory picker. To keep writing back to the downloaded file, mount
its containing folder and open that file in the explorer.
