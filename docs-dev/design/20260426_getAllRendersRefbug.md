# 2026-04-26: `getAllRenderersRef` Bug

## Summary

The concrete observed bug is that `ExecuteCode` notebook mutations can fail
with:

`ReferenceError: getAllRenderersRef is not defined`

The failure is not caused by the model-authored JavaScript. It is caused by the
host-side notebook mutation path invoking a renderer callback that depends on a
React closure.

The current mutation path is not atomic:

1. the notebook insert path mutates notebook state,
2. the host wrapper tries to notify renderers,
3. renderer-related code throws,
4. `ExecuteCode` reports failure,
5. the agent retries the same non-idempotent insert,
6. duplicate cells are appended.

We will fix this by removing renderer callbacks from notebook mutation paths.
Notebook mutations should update notebook state only. UI rendering should derive
from model state after the model emits, not from renderer callbacks inside the
mutation contract.

This applies to every notebook mutation entrypoint. We do not want one
mutation contract for code mode and a different one for local editing.

We should also evaluate removing the renderer registry entirely. Current code
suggests it is mostly legacy and only one renderer is still registered.

This document proposes a global architecture fix, not a one-off `ExecuteCode`
patch.

The broader `Actions.tsx` and output-rendering cleanup is tracked separately in
[#190](https://github.com/runmedev/web/issues/190).

## Motivation

The user-visible bug is duplicate notebook cells after a failed-looking
`ExecuteCode` call.

The specific failure mode is:

- `notebooks.update(...)` appends a cell,
- a later host-side step raises `ReferenceError: getAllRenderersRef is not defined`,
- the tool returns an error with no clear success signal,
- the agent retries the append.

That behavior makes the notebook API unsafe for non-idempotent mutations. The
agent did retry too aggressively, but the product bug is that a committed or
partially committed mutation is reported as a hard failure.

The same architectural problem exists outside `ExecuteCode`. Local editor
mutations also invoke renderer hooks as part of the mutation path. The
`ExecuteCode` failure is the clearest symptom because its retries made the bug
user-visible.

## Current Design

### Notebook model/view architecture

The web app already documents `NotebookData` as the in-memory notebook model.

`NotebookData` says:

- it owns all state for a single notebook
- React views subscribe via `subscribe(...)` and `getSnapshot()`
- mutations call `emit()` so views re-render

`NotebookContext` is the owner of `NotebookData` instances. It keeps a URI-keyed
registry of notebook models and exposes `useNotebookSnapshot(...)` so React can
re-render from model snapshots.

That means the intended architecture is:

1. notebook mutations update the model
2. the model emits change notifications
3. subscribed React views re-read model state and render

This is a model/view design. It is not a direct imperative render pipeline.

### Mutation paths today

There are at least two relevant notebook mutation entrypoints today:

- code-mode mutations through `notebooks.update(...)`
- local editor mutations through `Actions.updateCellLocal(...)`

Both rely on renderer hooks before or during model mutation.

### Code-mode mutation path

The relevant call chain is:

1. sandbox code calls `notebooks.update(...)`
2. `SandboxJSKernel` forwards `notebooks.update` to the host bridge
3. `createNotebooksApi(...).update(...)` applies notebook mutations
4. insert operations call `insertCells(...)`
5. `insertCells(...)` calls `appendCodeCell(...)`
6. `applyInsertedCellSpec(...)` calls `notebook.updateCell(updated)`
7. the page code-mode wrapper calls `getRenderers()`
8. `getRenderers()` evaluates `getAllRenderersRef.current().values()`

That last step is where the failing identifier is referenced.

### Local editor mutation path

The local editor path in `Actions.tsx` currently does:

1. iterate all registered renderers
2. call `renderer.onCellUpdate(nextCell)`
3. call `cellData.update(nextCell)`

`cellData.update(...)` then routes into `NotebookData.updateCell(...)`.

That means the local editor path has the same architectural flaw as code mode:
renderer hooks are participating in model mutation semantics.

### Where the architecture is violated

The violation is not that the code directly calls React render methods. The
violation is that notebook mutation is coupled to renderer-specific UI
preprocessing before the model update is complete.

Today `toNotebookDataLike(...).updateCell(...)` does:

1. iterate all registered renderers
2. call `renderer.onCellUpdate(cell)`
3. call `data.updateCell(cell)`

That is backwards for the documented model/view architecture.

The mutation path should not need renderer hooks to prepare the cell before the
model accepts it. Renderer behavior should derive from model state after the
model emits.

The code-mode path causes the concrete bug here, but the design issue is
broader: renderer hooks are currently participating in model mutation
semantics across multiple entrypoints.

### Renderer usage today

The web app still has live renderer machinery:

- `OutputContext` stores a `Map<string, OutputRenderer>`
- `ChatKitPanel` and `RunmeEvalHost` pass `getAllRenderersRef` into the
  code-mode executor
- `Actions` also calls `getAllRenderers()` during local cell updates

Current usage is much smaller than a general plugin-style renderer system:

- only one renderer is registered in the web app today:
  `MimeType.StatefulRunmeTerminal`
- the registration exists in `Actions.tsx`
- `getRenderer(...)` does not appear to be used in the web app runtime

The terminal renderer is doing two jobs:

1. it provides a component for terminal output rendering
2. its `onCellUpdate(...)` hook seeds empty terminal outputs for shell-like code
   cells

That second job is the one leaking into notebook mutation semantics.

## Root Cause

`getAllRenderersRef` is a React component ref. The code-mode notebook mutation
path should not depend on that ref to perform a model-visible state change.

The immediate bug is a scope failure around that ref or the callback that closes
over it. In JavaScript terms, `ReferenceError` means the identifier itself is
not bound in the current execution scope. This is different from a `TypeError`
caused by a null or undefined value.

The larger design bug is that notebook mutations are coupled to renderer
callbacks at all.

The insert path is especially risky:

- `appendCodeCell(...)` structurally mutates the notebook first
- `updateCell(...)` then applies the final cell contents
- renderer callbacks run inside that path

That means a renderer failure can happen after the mutation path has already
performed side effects. The API can therefore fail after partial success.

## Goals

- Make all notebook mutations deterministic and safe to retry.
- Remove React renderer scope from the notebook mutation contract.
- Use one model-driven mutation contract across all notebook entrypoints.
- Preserve terminal rendering behavior for shell-like cells.

## Non-Goals

- We do not need to redesign all notebook output rendering in this change.
- We do not need to preserve a general renderer-plugin abstraction unless there
  is a concrete current use case.

## Proposal

### Decision

We will separate notebook mutation from renderer notification everywhere.

Renderer callbacks must not participate in any notebook mutation path.

This applies to:

- code-mode notebook mutations
- local editor notebook mutations
- any future notebook mutation entrypoint built on `NotebookDataLike` or
  `NotebookData`

We will not preserve separate mutation semantics for different callers.

### Immediate fix

1. Remove renderer iteration from the page code-mode notebook wrapper.
2. Make code-mode notebook mutations update notebook state only.
3. Do not seed terminal markers during notebook mutation.
4. Remove renderer hooks from local editor mutation paths in the same design
   pass, even if the first shipped bug fix lands in code mode first.
5. Make `Actions.updateCellLocal(...)` a model-only mutation path.
6. If any temporary UI-only hook remains during transition, it must be
   best-effort and non-authoritative.
7. Improve `ExecuteCode` error reporting so it does not hide partial success.

### Concrete code changes

#### 1. Stop calling renderers from `pageCodeModeExecutor`

Today `toNotebookDataLike(...).updateCell(...)` calls:

- `getRenderers()`
- `renderer.onCellUpdate(cell)`
- `data.updateCell(cell)`

We should change that wrapper to call `data.updateCell(cell)` directly.

The code-mode executor is a notebook API bridge. It should not own UI
initialization side effects.

#### 2. Stop terminal seeding in mutation paths

The current renderer hook in `Actions.tsx` seeds a
`MimeType.StatefulRunmeTerminal` output for code cells that have no outputs.

We should stop seeding terminal markers during mutation.

For live execution, the view can already render `CellConsole` from active
stream state. That is the cleanest model/view behavior because it does not
require a mutation-time UI hint.

Our default policy should be:

- live terminal rendering comes from active stream state
- notebook mutation does not inject synthetic terminal output markers
- the view re-renders from model state after `NotebookData.emit()`

The key distinction is:

- acceptable: the view derives terminal presentation from model and execution
  state
- acceptable later, if required: a small explicit model-level signal that says
  a completed cell should still render with terminal presentation
- not acceptable: UI renderer hooks that mutate notebook state as a side effect

If post-run or replay behavior later proves that we need a persistent signal,
we should add a narrow model-level field or helper for that case. We should not
reuse renderer registration or synthetic output MIME markers as the mutation
mechanism.

The larger cleanup of output policy and terminal rendering in `Actions.tsx` is
tracked in [#190](https://github.com/runmedev/web/issues/190).

#### 3. Remove renderer hooks from local mutation paths

The local editor path should follow the same architecture as code mode.

`Actions.updateCellLocal(...)` should not call renderer hooks before mutating
the model.

The recommended behavior is:

- `Actions.updateCellLocal(...)` computes the next cell value
- `cellData.update(nextCell)` performs the mutation
- `NotebookData.emit()` notifies subscribers
- the view re-renders from model and stream state

`Actions.updateCellLocal(...)` should not:

- seed terminal outputs
- inject synthetic MIME markers
- call `renderer.onCellUpdate(...)`
- make rendering-policy decisions as part of mutation

If we need a temporary migration step, any remaining UI hook must be wrapped in
`try/catch` and must not prevent model updates.

Renderer failures should degrade rendering. They should not corrupt notebook
mutation semantics.

#### 4. Improve tool-level success reporting

When a mutation succeeds but a later UI step fails, the tool should return:

- a successful notebook mutation result
- plus warning output

It should not collapse the whole operation into an undifferentiated failure.

## Alternative: Remove Renderer Indirection Entirely

This is a viable option.

Reasons:

- only one renderer is registered today
- the current registration is local to `Actions.tsx`
- `getRenderer(...)` does not appear to be used
- there is already a TODO in `Actions.tsx` questioning whether renderer
  registration still makes sense

That suggests the renderer registry is now carrying legacy abstraction cost
without corresponding product value.

### Benefits

- simpler state flow
- fewer React closures crossing runtime boundaries
- no renderer registry in code-mode execution
- less hidden mutation logic
- a clearer separation between notebook state and output presentation policy

### Costs

- broader refactor than the immediate bug fix
- requires deciding where terminal output initialization belongs
- may touch UI rendering paths beyond Codex code mode

## Implementation Plan

This document covers the immediate architecture and correctness fix. The
broader `Actions.tsx` and output-rendering cleanup remains tracked separately
in [#190](https://github.com/runmedev/web/issues/190).

### Deliverables

This change is complete only when all four concrete code changes are complete:

1. stop calling renderers from `pageCodeModeExecutor`
2. stop terminal seeding in mutation paths
3. remove renderer hooks from local mutation paths
4. improve tool-level success reporting

### Work Plan

#### 1. Remove renderer callbacks from code-mode mutation

- update `toNotebookDataLike(...).updateCell(...)` to call
  `data.updateCell(cell)` directly
- remove any dependency on `getRenderers()` during notebook mutation
- keep code-mode notebook mutation focused on model updates only

#### 2. Remove terminal seeding from mutation paths

- remove mutation-time insertion of `MimeType.StatefulRunmeTerminal`
- rely on active stream state for live `CellConsole` rendering
- do not inject synthetic terminal MIME markers as part of notebook mutation

#### 3. Make local editing a model-only mutation path

- remove `renderer.onCellUpdate(...)` from `Actions.updateCellLocal(...)`
- have `Actions.updateCellLocal(...)` compute the next cell and call
  `cellData.update(nextCell)`
- let `NotebookData.emit()` and React subscription flow drive re-rendering

#### 4. Separate mutation success from later UI failures

- return notebook mutation success independently from later renderer or UI
  warnings
- do not report a committed notebook mutation as a hard failure because a later
  rendering step failed
- make non-idempotent notebook mutation APIs safe against duplicate retries

### Desired Runtime Flow

The desired propagation path is:

1. `notebooks.update(...)` mutates `NotebookData`
2. `NotebookData.updateCell(...)` updates state and emits
3. `NotebookContext` subscribers receive the model change
4. React components re-read notebook snapshots and re-render
5. output-specific components such as `CellConsole` decide how to display the
   new model state

That keeps mutation semantics inside the model and rendering semantics inside
the view.

### Completion Criteria

The implementation is complete when all of the following are true:

- code-mode notebook mutation no longer calls renderer hooks
- local editor mutation no longer calls renderer hooks
- notebook mutation paths no longer seed `StatefulRunmeTerminal`
- live terminal rendering still works from stream state
- a notebook mutation that succeeds is not reported as a hard failure because a
  later UI step failed
- the duplicate-cell retry failure mode is no longer possible from this class
  of partial success

### Out Of Scope For This Change

- removing the renderer registry entirely
- broader `Actions.tsx` output-policy cleanup
- redesigning completed terminal-output replay behavior beyond what is required
  for correctness

Those follow-on questions remain tracked in
[#190](https://github.com/runmedev/web/issues/190).
