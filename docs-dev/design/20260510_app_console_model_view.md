# 20260510 App Console Model-View Refactor

## Status

Draft proposal.

## Summary

Refactor App Console from a stateful React component into a model-view
architecture aligned with the existing notebook document model.

The current UI already persists console cells in IndexedDB, but the live source
of truth still lives inside `AppConsole.tsx` as local React state. That makes
it difficult for non-UI producers such as WebMCP `ExecuteCode` to append cells
and stream outputs into the mounted console.

We should introduce an `AppConsoleData` model that owns:

- console cells
- the active session id
- draft/running/completed cell transitions
- persistence
- subscriptions and snapshots for React

`AppConsole.tsx` should become a view over that model, not the owner of its
state.

## Problem

The current App Console has three conflicting roles:

1. UI rendering
2. execution orchestration
3. session persistence and state ownership

That works for user-triggered console execution inside one mounted component,
but it does not scale to multiple producers.

The concrete problem is external execution sources:

- WebMCP `ExecuteCode`
- future ChatKit or Codex code-mode logging
- possible programmatic “replay in console” flows

Those code paths can write to IndexedDB, but the mounted `AppConsole` will not
react because it does not subscribe to external storage changes. It only:

- hydrates once from `appConsoleStorage.loadLatestSession()`
- keeps the live transcript in `useState(...)`
- writes snapshots back with `saveCells(...)`

That means persistence exists, but shared live state does not.

## Relevant Current State

The current implementation is in:

- `app/src/components/AppConsole/AppConsole.tsx`
- `app/src/components/AppConsole/model.ts`
- `app/src/components/AppConsole/storage.ts`

What is already good:

- append-only cell UX already exists
- `ConsoleCell` and persisted row types already exist
- stdout/stderr/result output rendering already reuses `parser_pb.CellOutput[]`
- IndexedDB persistence already exists through Dexie

What is not yet aligned with the rest of the app:

- `cells` live in React component state
- session hydration logic lives in the component
- persistence debounce lives in the component
- history navigation state lives in the component
- execution state transitions live in the component
- external code cannot append cells through a shared runtime model

## Goals

- Make App Console state shareable across UI and non-UI producers.
- Align App Console with the repo’s model-view direction used by notebook data.
- Preserve the current append-only console UX.
- Allow external execution sources to create cells and stream outputs live.
- Keep persistence centralized and automatic.
- Make React a subscriber and renderer, not the owner of console state.

## Non-Goals

- Replacing the App Console cell UX again.
- Turning App Console into a first-class notebook document.
- Supporting collaborative multi-tab conflict resolution in v0.
- Replacing `parser_pb.CellOutput[]` with a new output schema.
- Solving every code execution path in the same change.

## Decision

We should rearchitect App Console to a model-view architecture.

More specifically:

- introduce an `AppConsoleData` model object
- move live transcript ownership out of `AppConsole.tsx`
- expose snapshots and subscriptions via `useSyncExternalStore`
- keep Dexie persistence as a storage backend, not the live state owner
- let App Console UI, WebMCP, and future producers mutate the same in-memory
  model through explicit APIs

This is the same architectural move we already made for notebook documents.

## Why Not Just Subscribe To Dexie

Dexie `liveQuery` or an IndexedDB event bus could make the UI react to external
writes, but that should not be the primary architecture.

Reasons:

- execution wants low-latency streaming updates, not storage-driven polling
- persistence is a side effect, not the domain model
- we need explicit state transitions such as `draft -> running -> success`
- React should not infer intent from database rows alone
- notebook data in this repo already treats persistence and live ownership as
  separate concerns

A storage subscription may still be useful later for cross-tab sync, but it
should not replace a proper model.

## Proposed Architecture

### Core model

Add a dedicated model, for example:

- `app/src/lib/appConsole/AppConsoleData.ts`

Recommended responsibilities:

- own `sessionId`
- own the ordered `ConsoleCell[]`
- own history-browse metadata if it must survive rerenders
- emit change events
- produce immutable snapshots for React
- persist state to storage
- expose mutation methods for execution producers

Recommended shape:

```ts
type AppConsoleSnapshot = {
  sessionId: string | null;
  hydrated: boolean;
  loadError: string | null;
  cells: ConsoleCell[];
};

class AppConsoleData {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AppConsoleSnapshot;

  hydrate(): Promise<void>;
  setCollapsed(value: boolean): void;

  setDraftSource(source: string): void;
  copyCellSourceToDraft(cellId: string): void;

  startExecution(source: string, options?: { producer?: string }): { cellId: string };
  appendStdout(cellId: string, chunk: string): void;
  appendStderr(cellId: string, chunk: string): void;
  completeExecution(cellId: string, result: { exitCode: number; result?: unknown }): void;
  failExecution(cellId: string, error: { exitCode?: number; message?: string }): void;
}
```

### React integration

Add a small hook:

```ts
function useAppConsoleSnapshot(): AppConsoleSnapshot;
```

This hook should mirror the notebook pattern:

- subscribe with `useSyncExternalStore`
- return a stable snapshot
- avoid React-local duplication of the transcript

`AppConsole.tsx` should then become mostly:

- UI layout
- editor callbacks
- run button / history button wiring
- rendering snapshot cells

### Persistence layer

Keep Dexie storage in `app/src/components/AppConsole/storage.ts`, but demote it
to a backend for the model.

The model should:

- hydrate from storage once
- persist after mutations, ideally debounced
- touch the session row on every meaningful transcript change
- recover interrupted `running` cells during hydration

The storage API can remain close to what exists today:

- `createSession(...)`
- `loadLatestSession()`
- `saveCells(...)`
- `touchSession(...)`

The main change is ownership, not schema.

### Execution producers

The model should support multiple producers writing to the same transcript.

Examples:

- App Console UI execution
- WebMCP `ExecuteCode`
- future ChatKit “show execution in console” paths

To make that work, producer code should not call `setCells(...)` directly. It
should call model methods such as:

- `startExecution(...)`
- `appendStdout(...)`
- `appendStderr(...)`
- `completeExecution(...)`

## Execution Integration

The current UI-driven execution path in `AppConsole.tsx` should be split into:

1. model updates
2. kernel orchestration

Suggested execution flow:

1. UI asks model to start execution for the current draft source
2. model freezes the draft cell into `running`
3. UI or helper creates `JSKernel`
4. kernel stdout/stderr callbacks call model append methods
5. completion callback calls `completeExecution(...)`
6. model appends a new draft cell

That same flow can be reused by WebMCP with a different producer label.

## WebMCP Integration

Once the model exists, WebMCP should not write to Dexie directly.

Instead:

1. `WebMcpToolRegistrationHost` calls a shared app-console execution helper or
   the model directly
2. the model creates a running console cell
3. `CodeModeExecutor` streams output into that cell
4. the model finalizes the cell on success or failure

This gives us:

- live UI updates while the tool runs
- persisted history after completion
- one transcript regardless of whether execution came from the App Console UI
  or WebMCP

## Streaming Output Gap

One implementation gap still exists in `codeModeExecutor.ts`.

Today it returns only the final merged output string:

```ts
Promise<{ output: string }>
```

For App Console integration, it should optionally surface streaming callbacks:

```ts
type CodeModeExecutionHooks = {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

execute(args: {
  code: string;
  source: CodeModeSource;
  hooks?: CodeModeExecutionHooks;
}): Promise<{ output: string }>;
```

The executor already has the internal chunk boundaries. It just needs to expose
them.

## Suggested File Layout

Recommended new files:

- `app/src/lib/appConsole/AppConsoleData.ts`
- `app/src/lib/appConsole/appConsoleController.ts`
- `app/src/lib/appConsole/useAppConsoleSnapshot.ts`

Recommended files to simplify:

- `app/src/components/AppConsole/AppConsole.tsx`

Existing files to retain with minimal shape changes:

- `app/src/components/AppConsole/model.ts`
- `app/src/components/AppConsole/storage.ts`

We can keep the UI files in `components/AppConsole/` and the runtime/data files
under `lib/appConsole/` to mirror how notebook data lives outside the view.

## Phased Plan

### Phase 1: Extract ownership

- introduce `AppConsoleData`
- move hydration and persistence out of `AppConsole.tsx`
- make React read snapshots from the model
- keep UI-driven execution behavior unchanged

### Phase 2: Extract execution helpers

- move App Console execution orchestration into a reusable helper
- add streaming hooks to `CodeModeExecutor`
- keep the App Console UI using that helper

### Phase 3: Add external producers

- wire WebMCP `ExecuteCode` into the App Console model
- append a console cell for each tool execution
- stream tool outputs live into the console

### Phase 4: Optional cross-tab behavior

- if needed, add storage subscriptions or BroadcastChannel sync
- keep this separate from the core model/view refactor

## Risks

### Risk: too much churn in one refactor

Mitigation:

- do Phase 1 first without WebMCP integration
- keep the existing cell UI and storage schema where possible

### Risk: duplicate draft cells or inconsistent indices

Mitigation:

- keep one model owner for all mutations
- centralize “append next draft cell” logic in the model

### Risk: persistence races

Mitigation:

- keep debounced persistence inside the model
- persist full ordered rows rather than partial row deltas in v0

### Risk: overcoupling model to React

Mitigation:

- keep React hooks thin
- put all business logic into the model/controller layer

## Open Questions

- Should collapsed state also move into the App Console model, or stay as a
  simple component-local/localStorage concern?
- Should history-browse state live in the model, or remain ephemeral UI state?
- Do we want a singleton global App Console session, or one session per
  workspace/project in the future?
- Should WebMCP executions always appear in App Console, or should that be a
  configurable behavior?

## Recommendation

Yes, the right way to support WebMCP-driven console cells is to rearchitect
App Console to model-view.

The narrow implementation recommendation is:

- introduce `AppConsoleData`
- make `AppConsole.tsx` a view over that model
- keep Dexie persistence as a storage backend
- expose execution mutation APIs for WebMCP and other producers

That gives us a coherent architecture instead of treating IndexedDB as an
accidental synchronization mechanism.

## References

- `app/design.md`
- `app/src/components/AppConsole/AppConsole.tsx`
- `app/src/components/AppConsole/model.ts`
- `app/src/components/AppConsole/storage.ts`
- `docs-dev/design/20260502_app_console_cells.md`
- `docs-dev/design/20260510_webmcp.md`
