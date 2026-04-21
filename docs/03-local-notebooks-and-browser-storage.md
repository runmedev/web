# Local Notebooks And Browser Storage

## What "local" means

Local notebooks are stored in the browser and are available without Google
Drive or the File System Access API.

These notebooks are a first-class backend, not just a temporary cache.

## Important behaviors

- browser-local notebooks use `local://...` URIs,
- local notebooks can be created from scratch,
- imported markdown usually lands here first,
- Drive-backed notebooks are often edited through a local mirror.

## Sync states

Drive-backed local notebooks can show sync states such as:

- synced,
- pending,
- pending upstream create,
- syncing,
- error,
- local-only.

## Why this matters

The UI deliberately separates:

- editable local state,
- upstream storage state.

That keeps the app usable when auth drops, connectivity fails, or an upstream
file is temporarily unavailable.

## High-value facts for Codex

- Do not assume "local" means disposable.
- A user can have important unsynced work entirely in browser storage.
- If a user reports missing Drive changes, check whether the notebook is still
  pending sync rather than assuming data loss.
