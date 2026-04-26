# Codex Web Frontend Execution Plan

## Summary

`docs-dev/design/20260310_codexapp.md` has moved the codex frontend design in two important ways:

1. Codex chat traffic no longer goes through a ChatKit-shaped `/chatkit-codex` HTTP/SSE adapter.
2. The browser now owns a Runme-level `project -> thread history -> turns` model on top of the Codex websocket proxy.
3. The ChatKit-to-Codex protocol conversion moves into the browser, implemented as a main-thread adapter/controller rather than a Web Worker in v1.

That means the old frontend split is no longer sufficient. The frontend work is now:

1. Harness selection and bootstrap (`responses` vs `codex`)
2. Codex project management in browser/AppKernel
3. Codex proxy client for lifecycle + thread management (`/codex/app-server/ws`)
4. Browser-side ChatKit/Codex adapter (`codexFetchShim` + `CodexConversationController`)
5. ChatKit UI integration for project selection, history, new chat, and interrupt
6. Existing `/codex/ws` notebook bridge and `ExecuteCells` approval flow

## Current State

Implemented already:

- Harness manager and `app.harness.*`
- Codex notebook bridge client on `/codex/ws`
- Browser fulfillment of notebook tool calls (`List/Get/Update/ExecuteCells`)
- `app.runCells([...])`
- Codex CUJ coverage for notebook mutation/approval

Out of date versus the latest design:

- Codex harness still routes ChatKit to `/chatkit-codex`
- No browser `CodexAppServerProxyClient`
- No browser-side `CodexConversationController` / `codexFetchShim`
- No Codex project manager
- No `app.codex.project.*` AppKernel/App Console helpers
- No project selector / `New chat` UI
- No project-scoped conversation history from `thread/list`
- No `thread/read` / `thread/resume` flow in the UI
- No `turn/interrupt` wiring from the chat UI

## Frontend Changes Required

### 1. Replace codex chat transport

For `codex` harnesses, the browser must stop using `POST /chatkit-codex` and instead:

- open `/codex/app-server/ws`
- send JSON-RPC requests for:
  - `thread/list`
  - `thread/read`
  - `thread/start`
  - `thread/resume`
  - `turn/start`
  - `turn/interrupt`
- receive streamed notifications for turn items/completion
- translate those notifications into ChatKit-visible message state
- expose a synthetic ChatKit-compatible `fetch` path in the browser by returning a `ReadableStream`-backed `text/event-stream` `Response`

Recommended browser shape:

- `CodexAppServerProxyClient`
  - raw JSON-RPC websocket client
- `CodexConversationController`
  - owns thread/turn lifecycle and history selection
- `codexFetchShim`
  - plugs into ChatKit's custom `fetch`
  - maps ChatKit send-message flow into controller calls
  - emits ChatKit-compatible SSE events from Codex notifications

Decision:

- do this on the main thread first
- do not introduce a Web Worker in v1
- keep the controller boundary clean so a worker migration stays possible later

Impacted frontend areas:

- `/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx`
- new runtime client under `/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/`
- harness URL builder in `/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/harnessManager.ts`

### 2. Add Codex project management

The browser needs a first-class Runme project abstraction because Codex only exposes thread defaults.

Required project fields:

- `id`
- `name`
- `cwd`
- `model`
- `approvalPolicy`
- `sandboxPolicy`
- `personality`
- optional `writableRoots`
- optional notebook/workspace metadata

Required frontend behavior:

- persist projects + default project in browser/AppKernel storage
- expose singleton manager to UI and AppKernel
- let user choose active project before starting/resuming chat
- use project `cwd` to scope conversation history

Required APIs:

- `app.codex.project.list()`
- `app.codex.project.create(name, cwd, model, sandboxPolicy, approvalPolicy, personality)`
- `app.codex.project.update(id, patch)`
- `app.codex.project.delete(id)`
- `app.codex.project.getDefault()`
- `app.codex.project.setDefault(id)`

Impacted frontend areas:

- new runtime manager under `/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/`
- `/Users/jlewi/code/runmecodex/web/app/src/components/AppConsole/AppConsole.tsx`
- `/Users/jlewi/code/runmecodex/web/app/src/lib/notebookData.ts`
- `/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/jsKernel.ts`

### 3. Add browser-side ChatKit/Codex adapter

The codex path still needs ChatKit/Codex protocol conversion. The difference is that the conversion now lives in the browser instead of Runme server.

Required runtime behavior:

- parse ChatKit request payloads from the custom `fetch` hook
- decide whether to:
  - `thread/start` for a new conversation
  - `thread/resume` for an existing stored thread
  - `turn/start` for the current user message
- turn Codex websocket notifications into ChatKit-compatible SSE events/messages
- map ChatKit cancel/abort to `turn/interrupt`
- keep auth/header handling in the browser fetch path

Required implementation structure:

- `CodexAppServerProxyClient`
- `CodexConversationController`
- `codexFetchShim`

Why not a Web Worker:

- transport is already async
- the complexity is state/protocol mapping, not CPU
- a worker adds another messaging protocol without reducing the core integration risk

### 4. Add project-scoped thread lifecycle in ChatKit UI

The ChatKit panel needs new codex-specific control state while keeping the existing layout.

Required UI additions:

- project selector in ChatKit header
- `New chat` action
- project-scoped history list from `thread/list`
- resume existing conversation by:
  - `thread/read` for preview/state
  - `thread/resume` before next user turn
- maintain `thread_id` as Codex thread id
- maintain `previous_response_id` as latest Codex turn id
- support `turn/interrupt` from the existing stop/cancel affordance

Required policy behavior:

- new chat starts a new thread using selected project defaults
- changing project should not silently mutate an existing unrelated thread
- history filtering must use exact `cwd`

Impacted frontend areas:

- `/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx`
- possible ChatKit wrapper/runtime files if the current `useChatKit` integration cannot ingest external websocket-driven state directly

### 5. Keep `/codex/ws` bridge, but rebind it to thread-driven chat flow

The notebook bridge work already exists, but it now needs to be integrated with the new lifecycle model.

Required behavior:

- keep one `/codex/ws` bridge per browser app session
- attach it whenever codex harness is active
- make it usable across many Codex threads in the same browser session
- keep notebook tool handling conversation-agnostic
- preserve `ExecuteCells` approval flow through `app.runCells([...])`
- surface bridge and proxy failures in logs without obscuring the chat UI

This is primarily an integration/refactor task, not a greenfield feature.

### 6. Add bootstrap + storage rules for codex projects

We already bootstrap harnesses. We need the same discipline for codex projects.

Required behavior:

- initialize a singleton project manager on app load
- prefer existing user-managed storage
- support initial seeding from app config if codex projects are later added there
- otherwise create a sensible fallback default project for local usage
- keep storage keys aligned with current naming patterns (`runme/...`)

Open implementation detail:

- storage key name for projects is not specified in the design doc; pick a stable key such as `runme/codex-project` or `runme/codex/projects` and use it consistently in manager, tests, and docs

## Proposed Execution Sequence

### Phase 1: Project Manager and AppKernel Surface

Goal:

- browser/AppKernel can create, update, list, and select Codex projects

Tasks:

- implement `CodexProjectManager`
- add storage + subscription model similar to harness manager
- expose `app.codex.project.*` in App Console
- expose `app.codex.project.*` in AppKernel notebook cells
- add tests for CRUD/default selection/persistence

Why first:

- project selection is a prerequisite for `thread/start`, `thread/list`, and history filtering

### Phase 2: Codex Proxy Runtime

Goal:

- browser can talk to `/codex/app-server/ws` using a typed runtime client

Tasks:

- add `buildCodexAppServerWsUrl(...)`
- generate or check in the TS protocol types for the supported methods/events
- implement `CodexAppServerProxyClient`
- support request/response correlation and streamed notifications
- support clean reconnect/disconnect/error handling

Tests:

- unit tests for request correlation and notification dispatch
- integration tests with a mocked/fake `globalThis.WebSocket`
- explicit coverage for malformed frames, disconnects, and in-flight errors

Why second:

- this is the transport foundation for lifecycle and history UI

### Phase 3: Browser-side ChatKit/Codex Adapter

Goal:

- codex harness uses websocket lifecycle operations instead of `/chatkit-codex`

Tasks:

- implement `CodexConversationController`
- implement `codexFetchShim`
- refactor `ChatKitPanel` so:
  - `responses` still uses existing `useChatKit` HTTP flow
  - `codex` uses the ChatKit custom `fetch` hook backed by the browser-side codex adapter
- translate Codex notifications into ChatKit-visible state/messages
- preserve existing responses behavior untouched
- wire `thread_id` / `previous_response_id` to Codex thread/turn ids
- wire stop/cancel to `turn/interrupt`

Key risk:

- the current `@openai/chatkit-react` integration is oriented around API transport ownership. The first attempt should preserve that contract by returning a synthetic SSE `Response` from the custom `fetch` hook. If ChatKit still assumes too much server behavior, we may need a thinner UI-only ChatKit wrapper that is fed by browser-owned state.

Tests:

- component tests for harness split:
  - `responses` still uses `/chatkit`
  - `codex` uses `/codex/app-server/ws`
- unit tests for turn-start, interrupt, and notification-to-message rendering

### Phase 4: Project Selector, New Chat, and History UI

Goal:

- user can choose a project, start a new thread, and resume prior project-scoped threads

Tasks:

- add project selector in ChatKit header
- add `New chat`
- fetch `thread/list` for selected project
- load previews/state with `thread/read`
- resume selected thread with `thread/resume`
- ensure project switch refreshes history and active-thread state predictably

Tests:

- component tests for selector/history interactions
- integration tests with fake proxy responses for:
  - project switch
  - new chat
  - resume existing thread
  - exact-`cwd` history filtering

### Phase 5: Rebind `/codex/ws` Notebook Bridge to the New Lifecycle

Goal:

- existing notebook bridge remains stable while chats are driven by threads via the proxy

Tasks:

- connect bridge independently of active thread
- ensure tool calls still update notebook state in the currently loaded notebook context
- verify `ExecuteCells` approvals still work after ChatKit transport refactor
- align logging/diagnostics across proxy and bridge

Tests:

- regression tests for existing `CodexToolBridge`
- integration test covering:
  - `turn/start`
  - notebook tool call over `/codex/ws`
  - `app.runCells([...])`
  - final assistant completion

## Test Plan

### Unit Tests

- `HarnessManager`
  - no transport regression for `responses`
  - new codex app-server websocket URL builder
- `CodexProjectManager`
  - CRUD
  - default selection
  - persistence/bootstrap
- `CodexAppServerProxyClient`
  - JSON-RPC request/response correlation
  - notification fanout
  - disconnect/error behavior
- `CodexConversationController`
  - thread state transitions
  - new-thread vs resumed-thread behavior
  - interrupt behavior
- `codexFetchShim`
  - ChatKit request parsing
  - SSE event generation
- ChatKit codex adapter
  - notification-to-rendered-message mapping

### Frontend Integration Tests

Use mocked/fake `globalThis.WebSocket`, not a real websocket server.

Coverage:

- proxy connect / disconnect / reconnect
- `thread/start` sends selected project defaults
- `thread/list` filtering results drive history list
- `thread/read` + `thread/resume` update active conversation
- notifications render visible assistant/user transcript state
- `codexFetchShim` returns a ChatKit-compatible `text/event-stream` response
- `/codex/ws` notebook tool calls still succeed while proxy client is active

### CUJ / E2E Tests

Use fake backend services implemented as real processes.

Required fake services:

- fake `/codex/app-server/ws` server
- fake `/codex/ws` notebook bridge server
- existing fake auth/bootstrap dependencies as needed

Required CUJs:

1. `ai.md` / responses path remains healthy
- user opens ChatKit
- user sends message
- assistant response is visible

2. codex project + thread lifecycle CUJ
- configure codex harness
- create/select project in App Console or AppKernel
- open ChatKit
- start new chat in that project
- visible user message and visible assistant acknowledgement render
- fake proxy emits project-scoped thread id + turn stream
- notebook mutation arrives over `/codex/ws`
- notebook visibly updates
- assistant completion renders

3. codex history/resume CUJ
- project has at least two stored threads
- history list is filtered by selected project `cwd`
- selecting a prior conversation resumes it
- follow-up user message continues that thread

4. codex execute approval CUJ
- assistant requests execution
- pending approval is surfaced
- `app.runCells([...])` is used
- stdout/stderr output is visible

All codex CUJs should continue producing walkthrough videos.

## Backend Dependencies

Frontend implementation can start behind fakes, but final integration depends on Runme server providing:

- `/codex/app-server/ws` websocket proxy
- supported JSON-RPC methods:
  - `thread/list`
  - `thread/read`
  - `thread/start`
  - `thread/resume`
  - `turn/start`
  - `turn/interrupt`
- stable notification shapes for item/turn events
- `/codex/ws` envelope compatibility with the existing bridge client
- precise proxy/bridge error codes so UI can show actionable diagnostics

## Recommended First PR Breakdown

1. `CodexProjectManager` + `app.codex.project.*` + AppKernel tests
2. `CodexAppServerProxyClient` runtime + websocket integration tests
3. `ChatKitPanel` codex transport refactor (`/codex/app-server/ws`)
4. project selector + `New chat` + history UI
5. codex lifecycle CUJs and bridge regression pass
