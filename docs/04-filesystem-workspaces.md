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

## What users should expect

- folders and `.json` notebook files appear in the explorer,
- the app can create notebook files in mounted folders,
- access can fail later if the browser revokes or loses permission.

## Important limitations

- the browser mediates file access and permissions,
- this is not a raw shell filesystem mount,
- unsupported browsers should fall back to local notebooks or Drive.

## High-value facts for Codex

- If a user asks to mount a filesystem path directly, the current UX still goes
  through the picker rather than accepting an arbitrary path string.
- `fs://...` items are upstream filesystem objects, not just browser-local copies.
