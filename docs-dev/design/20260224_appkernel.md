# AppKernel Design

## Scope

This document describes a special notebook runner, `AppKernel`, that executes
notebook cells inside the same browser-side `JSKernel` runtime used by the App
Console.

The goal is to make App Console helpers (`app`, `runme`, `drive`, `oidc`, etc.)
available to notebook cells through the normal notebook execution model, instead
of relying on one-off UI paths.

## Motivation

Today there are two separate execution paths for code cells:

- Remote runner path (websocket / Runme backend) used by `NotebookData.runCodeCell(...)`
- Browser-side JS path in `WebContainer` for JS/Observable-style cells

This causes drift:

- App Console runs on `JSKernel` with a rich helper surface.
- Notebook JS cells historically used a separate runtime path.
- Features like Google Drive manual validation notebooks want the same helper
  surface as App Console, but in notebook cells.

We should model this as a runner, not a special-case renderer behavior.

## Design Goals

- Reuse the same `JSKernel` execution model as App Console.
- Integrate with existing notebook runner selection (`cell.metadata[runnerName]`).
- Make local/browser execution explicit and user-selectable (`AppKernel` runner).
- Keep remote runner behavior unchanged for bash/python/etc.
- Support manual test notebooks that exercise Drive helpers in notebook cells.

## Non-Goals (v0)

- Replacing the remote Runme runner backend.
- Full parity for all shell/python semantics inside the browser.
- Implementing a fake Google Drive server integration for `gapi`.

## Proposed Model

Introduce a logical runner named `appkernel` (display label `AppKernel`) that:

- is selectable in the existing runner UI,
- is resolved by `NotebookData.getRunner(...)`,
- executes supported cells locally via `JSKernel`,
- does not open websocket streams to the Runme backend.

### Key Principle

`AppKernel` is a **runner choice**, not a language.

Language still matters, but in v0 AppKernel only supports `javascript`. The
runner determines where execution happens:

- remote runner -> websocket backend
- `AppKernel` -> local `JSKernel`

## Current State

Notebook cells execute through the existing notebook runner paths (primarily
remote runners via `NotebookData` + `Streams`).

There is no supported local notebook execution path that reuses the App Console
`JSKernel` helper surface today.

Manual notebook-based Drive validation remains blocked on AppKernel.

Implementation simplification:

- `WebContainer` has been removed as a legacy/failed experiment.
- This reduces design complexity because AppKernel no longer needs to preserve,
  adapt, or migrate a parallel browser-side notebook execution path.
- AppKernel can be implemented directly at the notebook runner layer
  (`NotebookData` / runner selection) without renderer-specific compatibility
  concerns.

## Architecture

### 1) AppKernel Runtime Module

Add a dedicated module (proposed):

- `app/src/lib/runtime/appKernelRunner.ts`

Responsibilities:

- Build the shared helper namespace used by App Console and notebook AppKernel cells.
- Execute a cell via `JSKernel`.
- Return notebook-native outputs plus execution metadata for `NotebookData`.

Proposed shape (illustrative):

```ts
type AppKernelEnvironment = {
  notebookApi: {
    resolveNotebook: (target?: unknown) => NotebookDataLike | null;
    openNotebook?: (uri: string) => Promise<void>;
  };
};

type AppKernelCellBindings = {
  refId: string;
  getCell: (refId: string) => parser_pb.Cell | null;
  updateCell: (
    cell: parser_pb.Cell,
    options?: { transient?: boolean },
  ) => void;
};

interface AppKernelRunner {
  runCell(cell: parser_pb.Cell, bindings: AppKernelCellBindings): Promise<void>;
  dispose?(): void;
}

function createAppKernelRunner(env: AppKernelEnvironment): AppKernelRunner;
```

Rationale:

- `NotebookData` is the owner of canonical `parser_pb.Cell` state.
- `AppKernelRunner` should follow the same ownership model as the remote stream
  path (`bindStreamsToCell(...)`): execution code emits updates through
  `getCell` / `updateCell`, instead of owning notebook mutation directly.
- notebook-resolution and other helper-environment concerns are dependencies of
  the runner/kernel, not per-cell execution inputs.
- A stateful runner mirrors App Console's long-lived `JSKernel` model while
  still keeping per-run output capture isolated.
- Rich outputs should be emitted as notebook MIME outputs (`CellOutputItem`s),
  not rendered imperatively into a live DOM container.

### 2) Shared Helper Builder

Avoid duplicating helper definitions across:

- `AppConsole.tsx`
- future `AppKernel` runner module

Extract helper construction into a shared builder, e.g.:

- `app/src/lib/runtime/appKernelGlobals.ts`

This builder should create the same helper namespaces:

- `app`
- `runme`
- `drive`
- `oidc`
- `googleClientManager`
- `help`

Inputs should include callbacks for:

- `sendStdout(...)` / logging
- notebook resolution (`getCurrentNotebook`)
- UI actions (open notebook, clear outputs, rerun, etc.)

AppKernel-specific note:

- v0 should not depend on `app.render(...)` / `app.clear()` DOM helpers.
- Rich output should flow through notebook MIME outputs (for example `text/html`)
  and be rendered by the notebook output layer (for example iframe-based HTML
  rendering), consistent with the direction used for ipykernel rich outputs.

### 2a) Stateful Kernel / Runner Lifetime

`AppKernelRunner` should own a long-lived `JSKernel` instance configured from an
injected environment.

Important distinction:

- stateful kernel = shared helpers / shared environment across runs
- not stateful run buffers = each `runCell(...)` call captures stdout/stderr for
  that run and applies updates through `updateCell(...)`

This matches App Console behavior (persistent kernel, repeated executions) while
keeping notebook cell execution results deterministic.

## Integration with NotebookData

### 3) Runner Identification

Add a conventional runner name for the local runtime:

- name: `appkernel`

Options:

- Persist as a normal runner entry in `RunnersManager` (recommended for UI consistency)
- Or reserve a built-in synthetic runner that is always available (simpler UX)

Recommendation (v0):

- Treat `AppKernel` as a built-in synthetic runner surfaced in UI and resolved
  by `RunnersManager.getWithFallback(...)`.
- Do not require a network endpoint for it.

### 4) NotebookData Execution Branch

Update `NotebookData.runCodeCell(...)` to branch on runner type:

- If runner is remote (current behavior): create websocket `Streams`, send execute request.
- If runner is `AppKernel`: execute locally via
  `AppKernelRunner.runCell(cell, bindings)`.

Important: local AppKernel execution should still update notebook metadata in a
way that fits the rest of the UI:

- increment sequence
- set `runme.dev/lastRunID`
- clear stale exit code/pid
- allow `AppKernelRunner` to update outputs via `updateCell(...)`
- set/clear exit code metadata

For AppKernel, `pid` should remain absent / null.

### 5) Cell Output Binding

Reuse existing helpers for output formatting:

- `createCellOutputs(...)`

Do not create a new output encoding format.

This keeps rendering and persistence consistent with remote executions.

Rich output direction (v0+):

- AppKernel should emit MIME-typed notebook outputs (for example `text/html`,
  `application/json`, images) as `CellOutputItem`s.
- The notebook output renderer is responsible for displaying these (including
  iframe-based HTML rendering where appropriate).
- This is intentionally aligned with ipykernel-style rich output handling rather
  than imperative in-execution DOM mutation.

Implementation note:

- `AppKernelRunner` may internally capture `stdout/stderr` from `JSKernel` hooks
  and convert them using `createCellOutputs(...)`.
- It should then apply those outputs by reading/updating the canonical cell via
  `getCell(...)` / `updateCell(...)`.
- `AppKernelRunner` should be constructed with environment dependencies
  (`notebookApi`) rather than receiving them on each run.

## UI / UX Changes

### Runner UI

- Show `AppKernel` in the runner selector for code cells.
- Make it clear that this runs in-browser and is intended for JS/AppConsole
  style helpers.

Potential label text:

- `AppKernel (browser JS)`

### Language Guidance

`AppKernel` is a runner, but v0 should support only:

- `javascript`

For unsupported languages under `AppKernel` (for example `bash`, `python`,
`appconsole`, `typescript`, `observable`, `d3`), v0 behavior should fail fast
with an actionable error:

- `"AppKernel only supports javascript cells in v0."`

Notes:

- `appconsole` remains an interim notebook language path today (via
  `WebContainer`), but it is not part of AppKernel v0 support.
- `typescript`, `observable`, and `d3` may be added later after we define how
  they compile/execute and express rich outputs as MIME payloads.
- v0 should prioritize JavaScript + MIME-based rich outputs.

## Migration Plan

### Phase 0 (current)

- App Console uses `JSKernel`.
- Notebook cells use existing notebook runner paths (`NotebookData` + remote runners).
- Manual Drive validation in notebooks is blocked until AppKernel is implemented.

### Phase 1

- Extract shared AppKernel helper builder.
- Implement `AppKernelRunner` module.
- Add built-in synthetic `AppKernel` runner to runner resolution/UI.
- Route `NotebookData.runCodeCell(...)` to local AppKernel path when selected.

### Phase 2

- Reduce duplicated helper wiring in `AppConsole` and notebook runtime.
- (Optional) remove any remaining ad hoc local notebook execution paths if they
  exist in the future.

### Phase 3

- Add `app.openNotebook(...)`, `drive.resolvePath(...)`, `drive.copy(...)`
  helpers and validate CUJs via notebook-based manual tests.

## Testing Plan

### Unit Tests

- `JSKernel` helper merge and execution semantics
- AppKernel helper builder (ensures namespaces match App Console expectations)
- AppKernel runner output updates via `getCell(...)` / `updateCell(...)` using `createCellOutputs(...)`
- Unsupported language handling under `AppKernel`

### Integration / Component Tests

- Notebook cell with runner `appkernel` executes JS and updates outputs
- Runner selector displays `AppKernel`
- `runme.*` helpers in notebook cells affect current notebook as expected

### Manual Validation

Use a Runme notebook with JavaScript cells (executed via AppKernel) to verify:

- auth status helpers
- app config helper access
- Drive create/update helpers
- later: copy/open CUJ

## Risks / Open Questions

### 1) Where should the shared helper builder live?

- `app/src/lib/runtime/appKernelGlobals.ts` is the likely home.
- It must avoid circular imports with React components and contexts.

### 2) How does AppKernel interact with output rendering?

- AppKernel should emit notebook MIME outputs.
- Existing notebook output renderers should handle display (including HTML/iframe
  rendering), rather than AppKernel owning a DOM execution surface.

### 3) How do we represent a synthetic runner in `RunnersManager`?

- May require a small extension to `Runner` (e.g. `kind: "remote" | "appkernel"`).
- Avoid overloading `endpoint` with sentinel strings if possible.

### 4) How much App Console surface should be exposed?

- v0 should expose the existing helper set used for Drive validation.
- Future additions should be made in the shared helper builder only, not copied
  into multiple components.
