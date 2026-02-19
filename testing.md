# Testing Strategy

## Google Drive Testing

This project needs deterministic, local testing for Google Drive flows (create, read, update, list, copy-oriented flows) without depending on live Google services.

### Goals

- Fast, repeatable tests in CI/local development.
- High confidence that fake Drive behavior matches real Drive behavior for the API subset we use.
- Easy switch between real Drive and fake Drive for manual and automated webapp testing.

## 1) Fake Google Drive Server (Go)

Implement a small Go HTTP server that emulates only the Drive endpoints we currently call:

- `POST /drive/v3/files` (create metadata)
- `PATCH /drive/v3/files/{fileId}` (metadata updates)
- `GET /drive/v3/files/{fileId}` (metadata and `alt=media`)
- `GET /drive/v3/files` (list/query)
- `PATCH /upload/drive/v3/files/{fileId}?uploadType=media` (media upload)

Design principles:

- Keep scope minimal: implement only request/response fields used by the app.
- Match status codes and error shapes from Drive for supported scenarios.
- Back fake data with an in-memory store by default; optional file-backed persistence for debugging.
- Support shared-drive flags we pass today (`supportsAllDrives`, `includeItemsFromAllDrives`).

Suggested location:

- `testing/servers/google-drive-fake/` (Go module with `cmd/fake-server` and package-level tests).

Server topology recommendation:

- Prefer one test server binary with pluggable endpoint modules (for example Drive now, other APIs later), rather than many unrelated binaries.
- Allow enabling/disabling modules via config/flags so tests can start only required endpoints.

## 2) Validate Fake Fidelity With Recorded Real API Data

Use a recorder program to capture real Google Drive request/response examples for a fixed scenario set, then verify fake responses against golden data.

### Recorder

Create a small manual tool (Go) that:

- Runs a deterministic scenario suite against real Drive (create folder/file, update metadata, upload media, list, get metadata, get media).
- Captures:
  - request method/path/query/body (sanitized)
  - response status/headers/body (sanitized)
- Writes fixtures to `testing/servers/google-drive-fake/testdata/golden/<scenario>.json`.

Sanitize volatile values before writing goldens:

- access tokens
- file ids (replace with stable placeholders)
- checksums/revision/version values that vary run-to-run
- timestamps/etag values

### Contract/Golden Tests For Fake

In fake-server unit tests:

- Replay each recorded request into fake server handlers.
- Compare normalized status/body to golden responses.
- Add stateful sequence tests (create -> upload -> get -> list -> rename) and assert final resource graph.

Update policy:

- Goldens are refreshed intentionally via a manual command (for example `go run ./cmd/drive-recorder --refresh`).
- PRs changing fake behavior must explain whether goldens changed because of:
  - real API behavior changes, or
  - fake bug fixes/scope expansion.

## 3) Webapp Must Be Configurable To Use Fake Drive

Add runtime Drive endpoint configuration in the webapp so tests can run end-to-end without real Drive.

Use runtime app configuration (not build-time `VITE_*`) for Drive endpoint selection:

- Serve config at a well-known path, e.g. `/configs/app-configs.yaml`.
- App loads this file on startup and applies Drive defaults from it.
- If `googleDrive.baseUrl` is an empty string, Drive client init falls back to official Google APIs URL.
- Test runs provide a config file that points `googleDrive.baseUrl` to the fake server.

Illustrative config shape:

```yaml
googleDrive:
  baseUrl: "http://127.0.0.1:9090"
```

Implementation direction:

- Keep one internal Drive REST client module used by storage code.
- Parameterize Drive API base URL from runtime config.
- Derive upload endpoint from Drive base URL in client initialization.
- Fall back to official Google endpoints when base URL is empty.
- In tests, set roots to fake server endpoints.
- Reuse Google Drive REST semantics/types to avoid drift.
- Keep `import.meta.env` defaults only as a fallback.

Note on official browser libraries:

- The current browser `gapi` usage does not provide a simple, global base-URL override for discovery-generated Drive methods.
- If endpoint-routing flexibility is required for fake servers, prefer a fetch-based REST wrapper with the same auth token flow.

## Test Pyramid For Drive Features

- Unit tests:
  - URI parsing and helper functions (`app/src/storage/drive.test.ts`, `app/src/lib/driveTransfer.test.ts`).
  - Fake server handlers and storage rules.
- Contract tests:
  - Golden replay tests for fake fidelity.
- Integration/browser tests:
  - Existing browser automation runs with fake backend enabled.
  - CUJ tests (for example copy current notebook) assert console output and resulting notebook data.
- Manual smoke against real Drive:
  - Run the recorder/scenario tool periodically or before release when Drive behavior assumptions change.

## Initial Rollout Plan

1. Implement fake server endpoints for current API subset.
2. Add recorder + first golden scenarios.
3. Add fake-server golden tests in CI.
4. Wire runtime Drive base-URL configuration and defaults.
5. Run browser CUJ tests against fake Drive in CI.
