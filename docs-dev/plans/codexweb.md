# Codex Web Frontend Plan

## Summary

This plan covers the frontend (`web`) work needed to support the codex harness path described in `docs-dev/design/codexapp.md`.

Your framing is correct with one refinement:

1. Harness selection/configuration (`responses` vs `codex`)
2. `/codex/ws` bridge connection and notebook tool fulfillment

Refinement: `ExecuteCells` approval (`app.runCells([...])`) is part of (2), because it is the frontend behavior for fulfilling a notebook tool request.

## Scope (Frontend Only)

- In scope:
  - Harness profile management and routing in the web app
  - ChatKit frontend routing to `/chatkit` vs `/chatkit-codex`
  - Codex websocket bridge client/runtime (`/codex/ws`)
  - Browser-side notebook tool dispatch (`List/Get/Update/ExecuteCells`)
  - UI/App Console handling for `ExecuteCells` approval
  - Frontend tests and CUJs

- Out of scope:
  - Runme server `/chatkit-codex` handler implementation
  - Codex app-server process manager / JSON-RPC adapter
  - Streamable MCP server implementation in Runme

## Workstream 1: Harness Selection and ChatKit Routing

### Goal

User can configure which harness to use (`responses` or `codex`) and ChatKit requests are routed to the matching backend path.

### Implementation Tasks

1. Harness state and bootstrap
- Add/finish global harness manager singleton as source of truth.
- Persist profiles + default in local storage key `runme/harness`.
- Bootstrap on app load using app-config preload pattern:
  - honor existing local storage if present
  - otherwise seed from `/configs/app-configs.yaml`
  - fallback to `local-responses` at `window.location.origin`

2. App Console commands
- `app.harness.get()`
- `app.harness.update(name, baseUrl, adapter)`
- `app.harness.delete(name)`
- `app.harness.getDefault()`
- `app.harness.setDefault(name)`
- Include active harness info in `help()` output

3. ChatKit frontend routing
- Use default harness profile to build ChatKit API URL/path:
  - `responses` -> `/chatkit`
  - `codex` -> `/chatkit-codex`
- Keep `ChatKitPanel` as the only chat UI
- Preserve `chatkit_state` behavior (`thread_id`, `previous_response_id`)

4. Diagnostics
- Clear error when harness config is invalid (unknown adapter, malformed URL)
- Clear UI/App Console feedback for active harness and routing target

### Tests

1. Unit tests
- Harness manager CRUD + default selection
- Bootstrap precedence (local storage > app config > fallback)
- URL/path builder for `responses` vs `codex`

2. Component/integration tests (frontend)
- `ChatKitPanel` routes to `/chatkit` for `responses`
- `ChatKitPanel` routes to `/chatkit-codex` for `codex`

3. CUJ coverage
- User can open ChatKit panel and chat using default fallback harness (`responses`)
- User can change harness via App Console
- User can chat after changing harness

## Workstream 2: Codex Websocket Bridge and Notebook Request Fulfillment

### Goal

When using the codex harness, the frontend opens `/codex/ws`, receives notebook tool requests, fulfills them using browser notebook APIs, and returns results. `ExecuteCells` requires explicit user approval.

### Implementation Tasks

1. Codex bridge client/runtime
- Add `CodexToolBridge` websocket client for `/codex/ws`
- Single connection per app session
- Connection lifecycle:
  - open on demand (codex harness active / chat panel use)
  - reconnect policy (if desired for v1) or explicit reconnect action
  - handle `409 codex_ws_already_connected` diagnostic
- Correlate requests/responses by `bridge_call_id`

2. Browser notebook tool fulfillment
- Dispatch `ListCells` via existing notebook APIs
- Dispatch `GetCells` via existing notebook APIs
- Dispatch `UpdateCells` via existing notebook APIs and renderer updates
- Return structured success/failure payloads over websocket

3. `ExecuteCells` approval flow (v0)
- Queue pending `ExecuteCells` request instead of executing immediately
- Surface pending request in UI/App Console
- Implement `app.runCells(["cellID", ...])` to approve and execute the queued request
- Reuse existing runner execution path after approval
- Return full stdout/stderr in tool response

4. Error and disconnect handling
- No bridge connected -> explicit diagnostic
- Bridge disconnect during pending request -> fail request cleanly
- Request timeout -> fail request with clear message
- Unknown tool / malformed payload -> structured error response

### Tests

1. Unit tests
- `CodexToolBridge` message decode/encode and `bridge_call_id` correlation
- Tool dispatch mapping (`List/Get/Update/ExecuteCells`)
- Pending approval queue semantics and `app.runCells(...)`
- Error mapping for malformed/unknown requests

2. Integration tests (frontend with fake websocket server)
- Use a `WebSocket` browser-API test double (mock/fake `globalThis.WebSocket`) in Vitest; do not require a real network websocket server for frontend integration tests
- Fake websocket peer sends notebook tool calls; frontend returns expected responses
- `UpdateCells` visibly mutates notebook state
- `ExecuteCells` is queued until `app.runCells(...)` approval is issued
- Disconnect mid-request produces deterministic failure response

Notes:
- The test double should support scripted `open`, `message`, `close`, and `error` events and capture `send(...)` payloads for assertions.
- Reserve a real fake `/codex/ws` server (for example in Go) for CUJ/E2E tests where we want to exercise actual browser network websocket behavior.

3. CUJ coverage (codex harness mode)
- Use fake backend services for determinism in CUJ/E2E:
  - fake `/chatkit-codex` SSE handler (scripted assistant response)
  - fake `/codex/ws` websocket server (scripted notebook tool calls)
- Configure codex harness in App Console
- Open ChatKit and verify codex bridge connection established
- Ask AI to modify a notebook cell (user-facing prompt)
- Fake `/codex/ws` sends `UpdateCells`; verify tool-driven notebook update appears in notebook UI and persisted notebook state
- `ExecuteCells` request surfaces approval prompt path (`app.runCells([...])`)
- After approval, execution output appears and tool result returns
- Verify assistant response appears in ChatKit panel
- Record walkthrough video artifact for the codex CUJ scenario

## Proposed Sequence

1. Finish/stabilize Workstream 1 (harness config + routing) and keep current AI CUJ green
2. Add `CodexToolBridge` skeleton + protocol types (no tool execution yet)
3. Implement `List/Get/Update` fulfillment and add fake websocket integration tests
4. Implement `ExecuteCells` pending approval + `app.runCells([...])`
5. Add codex-mode CUJ with fake backend(s) and stabilize artifacts (screenshots/videos)

## Acceptance Criteria

1. User can configure a named harness with adapter `codex` via App Console and set it default
2. ChatKit frontend routes requests to `/chatkit-codex` when codex harness is active
3. Frontend maintains a single `/codex/ws` bridge connection and handles conflict diagnostics
4. Frontend fulfills `ListCells`/`GetCells`/`UpdateCells` requests over the bridge
5. `ExecuteCells` requires explicit user approval (`app.runCells([...])`) before execution
6. CUJs cover harness switching and codex notebook-tool fulfillment paths

## Dependencies / Coordination (Runme Server)

Frontend implementation can begin with fakes, but final integration depends on Runme server providing:

- `/chatkit-codex` SSE-compatible handler
- `/codex/ws` websocket protocol + envelope schema
- Stable `NotebookToolCallRequest/Response` payloads with `bridge_call_id`
- Expected error codes (including websocket `409` conflict case)
