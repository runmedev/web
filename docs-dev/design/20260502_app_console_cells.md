# 2026-05-02: Append-Only App Console Cells

## Status

Draft proposal.

## Summary

We will replace the current terminal-style App Console with an append-only
sequence of JavaScript cells.

Each executed cell becomes immutable. Only the last draft cell is editable.
Running the draft cell freezes it, appends a new empty draft cell, and focuses
that new draft cell.

We will keep the existing AppKernel execution path. We will replace the
terminal emulation layer and `console-view` integration with a React cell list,
Monaco input editors, and notebook-style output rendering.

This design addresses the long-standing UX problems captured in
[issue #35](https://github.com/runmedev/web/issues/35). It also gives
agent-browser style automation a stable DOM contract for finding the current
input cell, execution state, and outputs.

## Motivation

The current App Console behaves like a terminal implemented inside a web app.
That creates two classes of problems.

The first problem is UX. Editing prior commands, navigating history, and
understanding where input ends and output begins all inherit the friction of a
character device UI.

The second problem is structure. The current console flattens input and output
into one stream. That makes it harder for automation to identify:

- the current editable command,
- the boundary between commands,
- whether a command is still running,
- which output belongs to which command.

The terminal implementation also duplicates behavior we already model better in
the notebook UI:

- a source editor,
- explicit execution state,
- typed outputs,
- append-only history.

## Current Design

`AppConsole` currently combines two separate concerns:

1. useful runtime logic we want to keep,
2. terminal emulation we want to remove.

Useful logic we should keep:

- `JSKernel` execution for browser-mode JavaScript
- `createAppJsGlobals(...)`
- `createRunmeConsoleApi(...)`
- workspace and notebook resolution
- filesystem-store lazy initialization

This logic lives in [AppConsole.tsx](/Users/jlewi/git_runmeweb/app/src/components/AppConsole/AppConsole.tsx:37),
[jsKernel.ts](/Users/jlewi/git_runmeweb/app/src/lib/runtime/jsKernel.ts:1),
[appJsGlobals.ts](/Users/jlewi/git_runmeweb/app/src/lib/runtime/appJsGlobals.ts:140), and
[runmeConsole.ts](/Users/jlewi/git_runmeweb/app/src/lib/runtime/runmeConsole.ts:565).

Terminal behavior we should remove:

- `console-view`
- prompt rendering (`> `)
- cursor math
- ANSI erase/move control sequences
- terminal stdin message handling
- terminal-style command history bound to arrow keys

That logic is concentrated in
[AppConsole.tsx](/Users/jlewi/git_runmeweb/app/src/components/AppConsole/AppConsole.tsx:243).

## Goals

- Make the App Console feel like an append-only notebook, not a terminal.
- Keep AppKernel JavaScript execution semantics unchanged.
- Make the current draft cell obvious.
- Make prior inputs and outputs easy to inspect.
- Make the DOM stable enough for automation to locate the current input cell,
  execution status, and outputs without parsing a terminal transcript.
- Reuse existing editor and output-rendering code where it fits.

## Non-Goals

- Turning the App Console into a persisted notebook document.
- Supporting arbitrary post-execution edits to old cells.
- Reproducing every terminal keybinding.
- Adding remote-runner terminal support to the App Console.

## Proposal

### UI model

The App Console will render a list of console cells.

Each console cell has:

- one JavaScript input editor,
- zero or more output blocks,
- explicit execution state,
- immutable source after execution,
- an optional action row for history-oriented actions such as copying a frozen
  cell back into the draft cell.

The final cell in the list is the draft cell. It is the only editable cell.

Executed cells are frozen records of what ran and what it produced. They are
history, not live editors.

### Editing semantics

We will not allow editing an executed cell and rerunning it in place.

We will use this rule consistently:

- draft cell: editable
- executed cell: immutable

Rationale:

- Immutable history is easier to reason about.
- Output remains tied to the exact input that produced it.
- Automation can trust that a completed cell will not silently change.
- The model matches chat and notebook history better than terminal rewrite
  behavior.

To re-run or modify prior work, the user edits the current draft cell.

### Execution semantics

When the user executes the current draft cell:

1. the draft cell status becomes `running`
2. execution starts through the existing AppKernel path
3. stdout/stderr/result blocks stream into that cell
4. the cell status becomes `success` or `error`
5. the cell becomes immutable
6. a new empty draft cell is appended and focused

The new draft cell is created even if the prior run fails. Failure is output and
status on the frozen cell, not a special editing mode.

### Keyboard semantics

The draft editor uses Monaco.

Execution shortcut:

- `Shift+Enter` runs the current draft cell

History shortcuts:

- `Shift+UpArrow` replaces the current draft contents with the previous command
- `Shift+DownArrow` moves forward through history

History navigation must preserve the user's in-progress draft buffer.

Required behavior:

1. If the user starts with a partially edited draft and presses
   `Shift+UpArrow`, we enter history-browse mode.
2. While browsing history, repeated `Shift+UpArrow` and `Shift+DownArrow`
   cycle through prior executed cell inputs.
3. When the user returns past the newest history item, the editor restores the
   exact draft buffer they had before entering history-browse mode.

This gives us the useful part of terminal history without making old cells
editable.

### Frozen-cell actions

Frozen cells should expose at least one explicit action:

- `Copy to draft`

`Copy to draft` replaces the contents of the current draft cell with the frozen
cell's source and focuses the draft editor.

This is complementary to keyboard history navigation.

Rationale:

- it is easier to discover than history shortcuts,
- it works even when the user wants to inspect an older cell visually before
  reusing it,
- it gives automation a clear UI affordance for reusing a prior command without
  mutating history.

### Data model

We should introduce a dedicated `ConsoleCellModel` instead of reusing the full
notebook document model.

Recommended shape:

```ts
type ConsoleCellStatus = "draft" | "running" | "success" | "error";

type ConsoleCell = {
  id: string;
  index: number;
  source: string;
  status: ConsoleCellStatus;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  outputs: parser_pb.CellOutput[];
};
```

We should reuse `parser_pb.CellOutput[]` for output payloads. That lets us reuse
existing output rendering and existing MIME conventions for stdout/stderr.

We should persist console cells in IndexedDB.

Recommended persistence model:

- one IndexedDB object store for console sessions,
- one object store for console cells,
- one row per cell,
- append-only writes for completed cells,
- one mutable row for the current draft cell,
- monotonic `index` within a session.

Recommended shape:

```ts
type PersistedConsoleCellRow = {
  sessionId: string;
  id: string;
  index: number;
  source: string;
  status: ConsoleCellStatus;
  outputs: parser_pb.CellOutput[];
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};
```

This should persist across reloads for the same browser profile.

On reload:

1. load the latest console session,
2. restore frozen cells in order,
3. restore the draft cell contents if a draft row exists,
4. reset any previously `running` cells to `error` or `interrupted` with a
   short recovery note because browser reload terminates in-flight execution.

We should not reuse `NotebookData` itself:

- App Console cells are app-scoped scratch state, not document cells.
- Notebook persistence, revisioning, and runner assignment add complexity we do
  not need here.
- The console needs exactly one mutable draft cell, which is not a notebook
  concept.

## Reuse Plan

### Logic we should keep

- `JSKernel`
- `createAppJsGlobals(...)`
- `createRunmeConsoleApi(...)`
- notebook/workspace resolution helpers from `AppConsole`
- filesystem-store initialization from `AppConsole`

We should extract those parts of `AppConsole` into a smaller hook or controller
that drives console cell execution.

### React/UI pieces we should keep

- Monaco editor wrapper from
  [Editor.tsx](/Users/jlewi/git_runmeweb/app/src/components/Actions/Editor.tsx:1)
- output rendering from
  [Actions.tsx](/Users/jlewi/git_runmeweb/app/src/components/Actions/Actions.tsx:433)

The existing `ActionOutputItems` renderer already understands notebook-style
output items and skips terminal-only MIME types when needed. Reusing that path
keeps App Console outputs visually aligned with notebook outputs.

### Pieces we should remove

- `console-view`
- terminal renderer context wiring
- ANSI prompt rendering
- terminal cursor movement logic
- terminal stdin parsing
- hidden transcript mirror used for test assertions

That hidden transcript mirror exists today at
[AppConsole.tsx](/Users/jlewi/git_runmeweb/app/src/components/AppConsole/AppConsole.tsx:475)
because the real UI is hard to inspect. The new design should make the visible
DOM itself the test and automation surface.

## Execution Controller

We should implement a small `AppConsoleController` that owns:

- the ordered list of console cells
- history browsing state
- the preserved draft buffer while browsing history
- the active run id for the current executing cell
- transitions from `draft -> running -> success|error`

It should call the same execution stack the current App Console uses today.

That means:

- build globals with `createAppJsGlobals(...)`
- run code with `JSKernel`
- capture stdout/stderr
- convert output into `parser_pb.CellOutput[]`
- store exit status on the console cell

This keeps the behavioral contract of AppKernel console execution stable while
letting us replace the UI.

## Automation Contract

The new App Console must expose explicit DOM semantics. Automation should not
need to infer state from visual order, CSS classes, or merged text blobs.

Each rendered cell should expose:

- stable `data-testid`
- stable cell id
- stable cell index
- explicit status
- explicit "current draft" marker

Recommended DOM shape:

```html
<section data-testid="app-console-cells">
  <article
    data-testid="app-console-cell"
    data-console-cell-id="c17"
    data-console-cell-index="17"
    data-status="draft"
    data-current="true"
  >
    <div data-testid="app-console-cell-header">
      <span data-testid="app-console-cell-index">17</span>
      <span data-testid="app-console-cell-status">draft</span>
    </div>

    <div data-testid="app-console-cell-input">
      <!-- Monaco host -->
    </div>

    <div data-testid="app-console-cell-actions">
      <button data-testid="app-console-cell-copy-to-draft">
        Copy to draft
      </button>
    </div>

    <div data-testid="app-console-cell-outputs">
      <div
        data-testid="app-console-cell-output"
        data-output-kind="stdout"
      ></div>
      <div
        data-testid="app-console-cell-output"
        data-output-kind="stderr"
      ></div>
      <div
        data-testid="app-console-cell-output"
        data-output-kind="result"
      ></div>
    </div>
  </article>
</section>
```

Required automation guarantees:

- Exactly one cell has `data-current="true"`.
- Exactly one editable input exists at a time.
- Every non-draft cell has stable source text and stable outputs.
- A running cell has `data-status="running"` until execution completes.
- Outputs are nested under the cell that produced them.
- Output blocks remain in the DOM after completion.
- Frozen-cell actions remain in the DOM after completion.

This makes common automation tasks straightforward:

- find the draft cell
- read the latest completed cell
- poll for completion
- read stdout/stderr/result separately
- copy a frozen cell into the draft cell through a visible control

### Validation against the current UI

We validated the current app with browser automation against
`http://localhost:5173/`.

Observed behavior:

- notebook and chat controls are exposed as normal DOM controls,
- runner state is readable from standard combobox-backed UI,
- harness state is readable from standard combobox-backed UI,
- the current App Console is not exposed as structured per-command DOM.

In the current implementation, App Console automation depends on a hidden
`data-testid="app-console-output"` mirror while the real console behavior lives
inside `console-view`. That mirror is useful for narrow assertions, but it does
not expose:

- command boundaries,
- current editable input,
- per-command status,
- outputs grouped by command.

The proposed append-only cell design fixes that gap by making the visible DOM
the primary inspection surface.

### Monaco-specific requirement

The automation contract must not depend on typing directly into Monaco internals
by class name.

We should wrap the Monaco host in a container with a stable test id and mark the
current editable cell at the cell container level. Automation can then:

1. find the current cell by `data-current="true"`
2. scope to `data-testid="app-console-cell-input"`
3. type into the editor using standard browser automation

## User Flow

Expected user flow:

1. User opens App Console.
2. App Console shows one empty draft cell.
3. User types JavaScript.
4. User presses `Shift+Enter`.
5. Cell runs and freezes.
6. A new empty draft cell appears below it.
7. User presses `Shift+UpArrow` to recall a previous command if needed.
8. User edits the recalled command in the current draft cell.
9. User presses `Shift+Enter` again.

This preserves fast command iteration without mutating history.

## Alternatives Considered

### Keep the terminal and improve it

We should not do this.

The terminal model is the source of the current UX and automation problems. It
keeps input and output flattened into one stream and forces us to keep solving
cursor and transcript edge cases in the browser.

### Allow editing executed cells in place

We should not do this.

That makes history ambiguous. One cell could represent multiple executions over
time, which weakens both the UX and the automation model.

### Reuse notebook document state directly

We should not do this in v0.

The App Console is not a notebook file. It needs a simpler controller with one
draft cell and append-only history. Reusing notebook output payload types is
useful. Reusing the full notebook document model is not.

### Allow non-JavaScript or markdown console cells

We should not do this in v0.

The App Console should stay JavaScript-only for now. That keeps the execution
model, editor configuration, persistence model, and automation contract simple.

## Migration Plan

1. Extract the current AppKernel execution setup from `AppConsole` into a
   controller or hook.
2. Define `ConsoleCell` state and transitions.
3. Build a new React cell-list UI behind a temporary feature flag.
4. Reuse the shared Monaco editor wrapper for the draft cell.
5. Reuse notebook-style output rendering for completed cells.
6. Add history navigation with preserved draft-buffer semantics.
7. Add stable `data-testid` and `data-*` automation attributes.
8. Remove `console-view` and terminal-only transcript plumbing once the new UI
   is complete.

## Testing

We should test three layers.

Unit tests:

- controller transitions
- history navigation semantics
- draft-buffer restore behavior
- execution status transitions

Component tests:

- only one editable cell exists
- executed cells render immutable source and outputs
- `Shift+Enter` runs the draft cell
- `Shift+UpArrow` / `Shift+DownArrow` browse history correctly

Browser tests:

- append-only execution flow
- output is rendered under the correct cell
- `Copy to draft` copies frozen source into the current draft cell
- persisted cells are restored after reload in the same browser profile
- automation can locate current cell, status, and outputs using only the
  public DOM contract

## Decisions

- Console history will persist across reloads in IndexedDB.
- Frozen cells will expose a `Copy to draft` action in v0.
- The App Console will stay JavaScript-only in v0.
