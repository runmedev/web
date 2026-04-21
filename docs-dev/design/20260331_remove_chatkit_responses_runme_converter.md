# Remove Runme Server ChatKit->Responses Converter

Date: 2026-03-31

## Summary

Remove the `ChatKit -> Runme server /chatkit -> Responses API` path.

Keep only:

1. `ChatKit -> browser responses-direct converter -> Responses API`
2. `ChatKit -> browser codex adapter -> Runme codex proxy -> Codex`

This reduces duplicated protocol conversion logic and removes a backend path that is no longer strategically needed.

## Current Invocation Paths

Today we effectively support three chat invocation paths:

1. `ChatKit -> Runme /chatkit -> Responses API` (server-side converter)
2. `ChatKit -> browser responses-direct converter -> Responses API`
3. `ChatKit -> browser codex adapter -> Runme codex proxy -> Codex app-server`

Path (1) duplicates conversion logic already implemented in (2), and carries separate backend auth/streaming behavior.

## Decision

Remove path (1) from product behavior and code.

Specifically:

- Remove `/chatkit` handler registration from Runme server.
- Remove `responses` harness adapter from web runtime options.
- Migrate existing harness configs to `responses-direct`.
- Keep Codex path unchanged.

## Rationale

- Fewer code paths for ChatKit protocol translation.
- Lower maintenance and regression risk.
- Clear architecture boundary:
  - Browser owns ChatKit protocol adaptation.
  - Runme server owns Codex proxy + notebook bridge only.
- Aligns with existing browser-first direction already used for Codex.

## Scope

In scope:

- Runtime routing and adapter selection in web app.
- Runme server route removal and related converter cleanup.
- Migration of persisted harness state.
- Tests/CUJs impacted by removing `/chatkit`.

Out of scope:

- Codex websocket protocol behavior changes.
- Notebook bridge (`/codex/ws`) behavior changes.
- Responses-direct feature expansion beyond what is needed for migration/testing.

## Target State

- No web runtime mode routes user chat to Runme `/chatkit`.
- Runme server does not register `/chatkit`.
- Harness adapters are only:
  - `responses-direct`
  - `codex`
- Existing local storage entries using `responses` are migrated to `responses-direct`.

## Required Changes: Runme Repo

### 1) Remove `/chatkit` endpoint registration

File:

- `runme/pkg/agent/server/server.go`

Changes:

- Remove import of `pkg/agent/ai/chatkit` in server wiring.
- Remove `chatKitHandler` field from `Server` struct.
- Remove `chatkit.NewChatKitHandler(...)` creation.
- Remove `mux.HandleProtected("/chatkit", ...)`.

### 2) Remove server-side ChatKit->Responses converter code

Files currently implementing converter behavior:

- `runme/pkg/agent/ai/chatkit/server.go`
- `runme/pkg/agent/ai/chatkit/responses.go`
- `runme/pkg/agent/ai/chatkit/annotations.go`
- `runme/pkg/agent/ai/chatkit/sse.go`
- `runme/pkg/agent/ai/chatkit/errors.go`
- `runme/pkg/agent/ai/chatkit/const.go`

Notes:

- Keep `runme/pkg/agent/ai/chatkit/datamodel.go` where it is. It is shared ChatKit datamodel/DTO code used by `pkg/agent/codex/*`.
- This cleanup removes the server-side converter path, not the shared ChatKit datamodel types.

### 3) Cleanup dead/legacy Codex ChatKit adapter usage (optional but recommended in same cleanup)

Potentially removable if truly unused in runtime wiring:

- `runme/pkg/agent/codex/chatkit_adapter.go`
- `runme/pkg/agent/codex/chatkit_adapter_test.go`

This adapter is not currently wired in `server.go`; verify no external entrypoints depend on it before deleting.

## Required Changes: Web Repo

### 1) Remove `responses` adapter from harness model

File:

- `web/app/src/lib/runtime/harnessManager.ts`

Changes:

- Change `HarnessAdapter` union from `responses | responses-direct | codex` to `responses-direct | codex`.
- Remove `/chatkit` route mapping.
- Default harness should be direct responses (adapter `responses-direct`).
- Add migration in storage load path:
  - Any persisted harness with `adapter: "responses"` is rewritten to `responses-direct`.

### 2) Update AppKernel/AppConsole adapter normalization

File:

- `web/app/src/lib/runtime/appJsGlobals.ts`

Changes:

- `normalizeHarnessAdapter` should no longer expose `responses` as a first-class adapter.
- Backward-compatible behavior option:
  - accept `"responses"` input but map to `"responses-direct"` with a warning message.

### 3) Remove legacy `/chatkit` branch in ChatKit panel runtime

File:

- `web/app/src/components/ChatKit/ChatKitPanel.tsx`

Changes:

- Eliminate logic branches that treat `responses` differently from `responses-direct`.
- For non-codex harness, always use `responsesDirectChatkitFetch`.
- Keep codex logic unchanged.

### 4) Update unit/component tests for harness modes

Files:

- `web/app/src/lib/runtime/harnessManager.test.ts`
- `web/app/src/components/ChatKit/ChatKitPanel.test.tsx`
- `web/app/src/lib/notebookData.test.ts`

Changes:

- Replace expectations for `responses` default/route with `responses-direct`.
- Remove tests that assert `/chatkit` URL routing.
- Keep codex assertions intact.

### 5) Update browser CUJ test strategy

Files:

- `web/app/test/browser/test-scenario-ai.ts`
- `web/testing/aiservice/main.go`

Current issue:

- CUJ currently asserts `responses` harness and fake `/chatkit` traffic.
- `responses-direct` calls OpenAI Responses directly, so existing fake `/chatkit` backend is bypassed.

Required adjustment options:

1. Add test-only override for Responses API base URL in `responsesDirectChatkitFetch`, then point CUJ to fake service implementing `/v1/responses`.
2. Move this CUJ to codex-only path and retire fake `/chatkit` assertions.

Option (1) is preferred to preserve non-codex coverage without external OpenAI dependency in CI.

## Compatibility and Migration

### Local storage migration

- Storage key: `runme/harness`.
- On load:
  - convert `adapter: "responses"` to `adapter: "responses-direct"`.
  - preserve harness name/baseUrl to avoid user-visible churn.

### Script/API compatibility

- `app.harness.update(..., "responses")` should map to `responses-direct` for one transition window, then be removed.

## Validation Plan

Runme:

- Verify server starts and no `/chatkit` handler is registered.
- Verify codex endpoints still function:
  - `/codex/app-server/ws`
  - `/codex/ws`
  - `/mcp/notebooks`

Web:

- Harness routing tests pass for:
  - `responses-direct`
  - `codex`
- ChatKit panel can send/receive in `responses-direct`.
- Codex chat flow unchanged.
- Browser CUJs updated and passing with deterministic fake backend behavior.

## Risks and Mitigations

Risk: Breaking existing users with stored `responses` harness.

- Mitigation: automatic migration + temporary alias in AppKernel/API helpers.

Risk: Loss of deterministic AI CUJ coverage if responses-direct still points to real OpenAI.

- Mitigation: add test-only Responses endpoint override and fake `/v1/responses` server behavior.

Risk: Accidental deletion of chatkit DTOs still referenced by codex code.

- Mitigation: split shared DTOs before deleting converter package, or perform converter deletion in two PRs.

## Proposed Implementation Order

1. Web harness migration + adapter removal (`responses` -> `responses-direct`).
2. Update web tests and CUJ plumbing for responses-direct.
3. Remove Runme `/chatkit` route registration.
4. Remove Runme converter files and keep/move only shared DTOs still needed by codex code.
5. Final cleanup of dead codex chatkit adapter code if confirmed unused.
