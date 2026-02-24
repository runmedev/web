# Drive Design Notes

## Scope

This document captures implementation planning for Google Drive workflows used by the web app and App Console.

## Key Design Decisions

### 1) Do not rely on `gapi` endpoint override for fake-server testing

- The current `gapi` usage loads Drive via discovery (`gapi.client.load("drive", "v3")`) and also uses hardcoded Google upload URLs.
- This makes fake-server routing awkward and brittle.
- For testability, prefer a small fetch-based Drive REST client in the webapp, while keeping Google OAuth token acquisition unchanged.
- Near-term pragmatic choice: validate current `gapi` behavior with manual tests against real Drive (using a Runme notebook that exercises operations), and defer fake-server integration for `gapi`.

### 2) Keep the abstraction backend-agnostic

- If we introduce a wrapper/interface, it should model generic file operations (read/write/list/stat/copy) and be reusable across backends (Drive, local filesystem, blob/object storage).
- Do not make the top-level interface Google-Drive-specific.
- Drive-specific behavior (path resolution, duplicate handling) should live in Drive helpers/adapters on top of the generic interface.

Example direction (TypeScript, illustrative only):

```ts
interface FileStore {
  stat(uri: string): Promise<FileEntry | null>;
  read(uri: string): Promise<string>;
  write(uri: string, content: string, opts?: WriteOptions): Promise<FileEntry>;
  list(uri: string): Promise<FileEntry[]>;
  mkdir(uri: string): Promise<FileEntry>;
  copy?(srcUri: string, dstUri: string): Promise<FileEntry>;
  join(baseUri: string, ...parts: string[]): string;
}
```

### 3) Use stable ID-backed URIs as canonical identity

- Drive file/folder IDs are not human friendly, but they are stable and unambiguous.
- Human-friendly path strings (for example `"folder/subfolder/name.json"`) should be resolved via a helper API, not treated as canonical identity.
- This avoids ambiguous semantics when duplicate names exist in the same folder.

### 4) Provide a Drive path resolver helper

- Prefer `drive.resolvePath(path, options)` over encoding path semantics into a `gdrive://...` URI.
- `resolvePath(...)` should surface duplicate-name ambiguity explicitly (for example `duplicate: "error"` by default).
- Returned values should include canonical URI(s) so follow-on operations use stable identifiers.

## Copy Current Notebook: Implementation Plan

Related CUJ:

- `docs-dev/CUJs/copy-current-notebook-to-drive.md`

### v0

- Console API shape:
  - `app.getCurrentNotebook()`
  - `drive.resolvePath(path, { createParents: true, duplicate: "error" })`
  - `drive.copy(source, target)`
  - `app.openNotebook(copied.uri)`
- Behavior:
  - destination must not already exist
  - path resolution must fail on duplicate-name ambiguity
  - copy notebook payload exactly
  - open copied notebook after successful copy

### v1

- Improve path ergonomics and help text around `drive.resolvePath(path, ...)`.
- Improve user-facing validation errors for invalid target paths.
- Consider resolver modes for duplicates (`first`, `newest`, `all`) while keeping `error` as the default.

### v2

- Add explicit overwrite mode.
- Add conflict-handling behavior for destination collisions and concurrent edits.

## Drive Testing Alignment

Drive implementation should align with:

- `testing.md` for fake-server and golden-contract testing.
- `docs-dev/architecture/configuration.md` for runtime config loading and test environment wiring.

### Fake Injection and Runtime Config

- Runtime config (`/configs/app-configs.yaml`) should provide `googleDrive.baseUrl`.
- Empty `googleDrive.baseUrl` means use official Google endpoints.
- Non-empty `googleDrive.baseUrl` routes Drive REST requests (including uploads) to the fake server.
- Upload endpoint should be derived from the base URL in client code; no separate `uploadBaseUrl` config is required.

### Near-Term Manual Validation Plan (Real Drive)

- We will rely on a manual test notebook (Runme notebook) that executes Drive operations against the real Drive API to validate the current implementation behavior.
- This is intended as a temporary validation path while Drive abstractions and fake-server support evolve.
- This manual test plan is currently blocked on supporting AppConsole-style cells in notebooks (so notebook cells can execute the same app/drive helper APIs used by the App Console).
- Once AppConsole cells are supported in notebooks, add a reusable manual verification notebook that covers:
  - auth/token check
  - path resolution
  - copy notebook
  - open copied notebook
  - metadata/list verification
