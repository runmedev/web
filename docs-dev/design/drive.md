# Drive Design Notes

## Scope

This document captures implementation planning for Google Drive workflows used by the web app and App Console.

## Copy Current Notebook: Implementation Plan

Related CUJ:

- `docs-dev/CUJs/copy-current-notebook-to-drive.md`

### v0

- Console API shape:
  - `app.getCurrentNotebook()`
  - `drive.newNotebook(path)`
  - `drive.copy(source, target)`
  - `app.openNotebook(copied.uri)`
- Behavior:
  - destination must not already exist
  - copy notebook payload exactly
  - open copied notebook after successful copy

### v1

- Improve path ergonomics and help text around `drive.newNotebook(path)`.
- Improve user-facing validation errors for invalid target paths.

### v2

- Add explicit overwrite mode.
- Add conflict-handling behavior for destination collisions and concurrent edits.

## Drive Testing Alignment

Drive implementation should align with:

- `testing.md` for fake-server and golden-contract testing.
- `docs-dev/architecture/configuration.md` for runtime config loading and test environment wiring.
