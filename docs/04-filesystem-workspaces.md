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
`.runme` file to create its browser mirror. Runme saves
edits there first. While the app runs, the storage worker checks previously
opened notebooks in mounted folders every two minutes, even after you close a
notebook tab. A filesystem mount works offline without a Drive OAuth client.

Runme lists and creates only `.runme` notebooks in mounted directories. It
merges operations from disk and the browser copy. The notebook
sync indicator shows errors and lets you retry. Use **Reconnect folder** from
the mounted root's context menu if access expires. Removing a mount leaves the
files on disk. Select the same directory again to reconnect its mirrors.

## Download and open a snapshot

Choose **Download notebook** from the notebook tab's context menu. To edit a
downloaded `.runme` file, mount its containing directory and open it from
Explorer. This requires a browser with directory-picker support.
