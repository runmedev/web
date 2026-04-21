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
- create a new notebook in a folder,
- rename a notebook,
- remove a mounted folder,
- copy a notebook share link.

## Canonical App Console entry points

```js
explorer.help()
explorer.addFolder()
explorer.openPicker()
explorer.importMarkdown()
explorer.mountDrive("https://drive.google.com/...")
explorer.listFolders()
explorer.removeFolder(uri)
```

## Explorer behavior details

- `Local Notebooks` is always expected as a baseline workspace root.
- Folder expansion is lazy; children are fetched when the folder opens.
- Drive links may enqueue coordination work before a notebook becomes editable.

## High-value facts for Codex

- Opening a file from the explorer is the safest way to make it the current document.
- Removing a folder from the explorer does not necessarily delete its upstream source.
- Explorer items may have local URIs and separate `remoteUri` values.
