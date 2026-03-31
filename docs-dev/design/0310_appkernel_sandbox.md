# 0310 AppKernel Sandbox (Issue #154 Focus)

## Status

Draft revision for [issue #154](https://github.com/runmedev/web/issues/154).

## Why This Revision

The first draft mixed several goals (sandbox, network, Drive, generic helpers).
Issue #154 is more focused:

- execute AI-generated TS/JS that manipulates notebooks,
- avoid fragile multi-tool notebook mutations,
- prevent wrong-notebook writes when UI tab focus changes,
- hide proto enum details from AI code (for example `CellKind` values).

This revision narrows v0 to notebook manipulation through a sandboxed kernel and
a single notebook API contract with host/sandbox implementations.

## Problem Statement

Current AppKernel execution is in-process (`new Function(...)`) and receives a
large helper surface from `createAppJsGlobals(...)`.

- `app/src/lib/runtime/jsKernel.ts`
- `app/src/lib/runtime/appJsGlobals.ts`
- `app/src/lib/notebookData.ts`

That model has two gaps for agentic notebook edits:

1. Safety: untrusted code runs in the main realm.
2. Reliability: edits depend on ad hoc tool/proto details, which causes wrong
   cell kinds and wrong notebook targeting.

## Goals (v0)

- Run AI-generated notebook code in an isolated browser sandbox.
- Expose a single `NotebooksApi` contract to agent code.
- Provide two implementations of that same contract:
  - host implementation backed by `NotebookData`,
  - sandbox client implementation that RPCs to host.
- Enforce host-side policy on every API call.
- Guarantee notebook targeting by explicit notebook handles, not "current tab".
- Make all notebook writes undoable from host-managed history.
- For `javascript` cells, expose explicit runner selection (`browser` or
  `sandbox`) with `browser` as default.

## Non-Goals (v0)

- Google Drive mutation from sandbox code.
- General-purpose network access from sandbox code.
- Full parity with all current `app.*` and `runme.*` helpers.
- Process-level isolation guarantees.

## Architecture

### JS Runner Selection (v0 UX + routing)

For `javascript` language cells, show a runner dropdown with exactly two values:

- `browser` (default)
- `sandbox`

Behavior:

- `browser` keeps current AppKernel execution semantics (higher-privilege
  browser context, including existing local app capabilities).
- `sandbox` routes execution to the sandboxed kernel path for validation/testing
  of least-privilege behavior.
- Non-JS languages keep current runner behavior (`bash`/`python` use configured
  runners; `jupyter` uses kernel selector).

Metadata mapping (proposed):

- `browser` => `RunmeMetadataKey.RunnerName = "appkernel-js"`
- `sandbox` => `RunmeMetadataKey.RunnerName = "appkernel-js-sandbox"`

Notes:

- Defaulting to `browser` preserves backward compatibility and current user
  expectations.
- The explicit selector gives users a deliberate way to choose reduced
  privileges for testing and gradual migration.

### Layer 1: Notebook SDK (used by AI code)

Provide a TS library focused on notebook operations (cells, metadata, outputs)
without exposing protobuf wire details directly.

Initial v0 API shape uses one primary noun: `notebooks`.

```ts
type NotebookSummary = {
  uri: string;
  name: string;
  isOpen: boolean;
  source: "local" | "fs" | "contents" | "drive";
};

type NotebookQuery = {
  openOnly?: boolean;
  uriPrefix?: string;
  nameContains?: string;
  limit?: number;
};

type NotebookHandle = {
  uri: string;
  revision: string;
};

type NotebookTarget =
  | { uri: string }
  | { handle: NotebookHandle };

type NotebookDocument = {
  summary: NotebookSummary;
  handle: NotebookHandle;
  notebook: unknown;
};

type CellPatch = {
  value?: string;
  languageId?: string;
  metadata?: Record<string, string>;
  outputs?: unknown[];
};

type CellLocation =
  | { index: number } // 0=start, -1=end, -2=before end
  | { beforeRefId: string }
  | { afterRefId: string };

type InsertCellSpec = {
  kind: "code" | "markup";
  languageId?: string;
  value?: string;
  metadata?: Record<string, string>;
};

type NotebookMutation =
  | {
      op: "insert";
      at: CellLocation;
      cells: InsertCellSpec[];
    }
  | {
      op: "update";
      refId: string;
      patch: CellPatch;
    }
  | {
      op: "remove";
      refIds: string[];
    };

type NotebookMethod =
  | "list"
  | "get"
  | "update"
  | "delete"
  | "execute";

interface NotebooksApi {
  help(topic?: NotebookMethod): Promise<string>;
  list(query?: NotebookQuery): Promise<NotebookSummary[]>;
  get(target?: NotebookTarget): Promise<NotebookDocument>;
  update(args: {
    target?: NotebookTarget;
    expectedRevision?: string;
    operations: NotebookMutation[];
    reason?: string;
  }): Promise<NotebookDocument>;
  delete(target: NotebookTarget): Promise<void>;
  execute(args: {
    target?: NotebookTarget;
    refIds: string[];
  }): Promise<{ handle: NotebookHandle; cells: unknown[] }>;
}
```

Design notes:

- `list/get/update/delete` provide CRUD semantics on the `notebooks` noun.
- `execute` is explicitly non-CRUD but required for notebook workflows.
- Handle contains `uri + revision` in v0; this is sufficient for identity plus
  optimistic concurrency.
- `update` is the single mutation entry point and accepts a sequence of
  operations (`insert`, `update`, `remove`).
- Location supports both numeric position and relative placement
  (`beforeRefId`/`afterRefId`).
- SDK owns enum/string normalization so model code does not manually encode
  protobuf details like `CellKind`.
- When `target` is omitted, calls resolve to a session-pinned default notebook
  selected at run start (not the live currently selected UI tab).

### Layer 1b: Example Snippets

```ts
// 0) Discover available signatures
console.log(await notebooks.help()); // summary of list/get/update/delete/execute
console.log(await notebooks.help("update")); // update(...) signature + examples
```

```ts
// 1) Get the current (session-pinned) notebook and its contents
const current = await notebooks.get();
console.log(current.handle.uri, current.handle.revision);
console.log(current.notebook);
```

```ts
// 2) Insert a cell between two existing cells (relative placement)
await notebooks.update({
  target: { handle: current.handle },
  operations: [
    {
      op: "insert",
      at: { afterRefId: "cell_a" },
      cells: [
        {
          kind: "code",
          languageId: "javascript",
          value: "console.log('inserted between a and b')",
        },
      ],
    },
  ],
});
```

```ts
// 3) Remove a cell
await notebooks.update({
  target: { handle: current.handle },
  operations: [{ op: "remove", refIds: ["cell_to_remove"] }],
});
```

```ts
// 4) Add a cell at the end (position semantics)
await notebooks.update({
  target: { handle: current.handle },
  operations: [
    {
      op: "insert",
      at: { index: -1 }, // append to end
      cells: [
        {
          kind: "code",
          languageId: "javascript",
          value: "console.log('new last cell')",
        },
      ],
    },
  ],
});
```

```ts
// 5) Replace contents of a cell
await notebooks.update({
  target: { handle: current.handle },
  operations: [
    {
      op: "update",
      refId: "cell_to_replace",
      patch: {
        value: "console.log('replacement code')",
        languageId: "javascript",
      },
    },
  ],
});
```

```ts
// List all open notebooks
const open = await notebooks.list({ openOnly: true });
open.forEach((n) => console.log(n.uri, n.name, n.source));
```

### Layer 2: Implementations and Transport

Use the same `NotebooksApi` interface in both environments.

```ts
interface NotebooksApi {
  help(topic?: NotebookMethod): Promise<string>;
  list(query?: NotebookQuery): Promise<NotebookSummary[]>;
  get(target?: NotebookTarget): Promise<NotebookDocument>;
  update(args: {
    target?: NotebookTarget;
    expectedRevision?: string;
    operations: NotebookMutation[];
    reason?: string;
  }): Promise<NotebookDocument>;
  delete(target: NotebookTarget): Promise<void>;
  execute(args: {
    target?: NotebookTarget;
    refIds: string[];
  }): Promise<{ handle: NotebookHandle; cells: unknown[] }>;
}

interface NotebooksApiBridgeServer {
  handleMessage(request: unknown): Promise<unknown>;
}
```

Implementations:

- `HostNotebooksApi`: concrete implementation using `NotebookData` and storage adapters.
- `SandboxNotebooksApiClient`: same methods, implemented as RPC over `MessageChannel`.
- `NotebooksApiBridgeServer`: receives RPC envelopes, validates schema/policy, then delegates to `HostNotebooksApi`.

### Layer 2a: Minimal IndexedDB Core (host persistence adapter)

To make notebook libraries portable between host and sandbox, we split:

- high-level notebook SDK (operation semantics),
- low-level persistence core (load/save/revision over IndexedDB).

Proposed host-only low-level interface:

```ts
type NotebookDoc = unknown;

type NotebookRecord = {
  uri: string;
  name: string;
  revision: string; // md5 or equivalent monotonic content hash
  notebook: NotebookDoc;
};

interface NotebookDbCore {
  get(uri: string): Promise<NotebookRecord | null>;
  create(parentUri: string, name: string): Promise<{ uri: string; name: string }>;
  rename(uri: string, name: string): Promise<{ uri: string; name: string }>;
  saveIfRevision(args: {
    uri: string;
    notebook: NotebookDoc;
    expectedRevision: string;
  }): Promise<{ revision: string }>;
  listOpen(): Promise<Array<{ uri: string; name: string }>>;
}
```

Notes:

- `saveIfRevision` provides compare-and-swap semantics needed by sandbox
  `update` flows and prevents stale writes.
- `revision` maps to the local checksum (`md5Checksum`) already maintained by
  `LocalNotebooks`.
- `listOpen()` is sourced from host open-notebook state, not IndexedDB file
  enumeration.
- This API is intentionally persistence-oriented; open notebook mutation should
  still flow through `NotebookData` for live state consistency.

### Layer 3: Sandbox Kernel Adapter

Untrusted code runs in a sandboxed iframe (`sandbox="allow-scripts"` and no
`allow-same-origin`).

Inside the sandbox, `SandboxNotebooksApiClient` is a transport adapter over
`MessageChannel` RPC. The API surface remains `NotebooksApi`.

### Layer 4: Host Broker + Policy Engine

Main app receives notebook API calls and enforces rules before touching notebook
state:

1. Method allowlist.
2. Schema validation.
3. Capability checks for notebook scope.
4. Revision checks (`expectedRevision`) for optimistic concurrency.
5. Mutation limits (max ops, max payload bytes, max runtime).
6. Write + undo log entry.

Only after these checks does the bridge delegate to `HostNotebooksApi`.

## Notebook Targeting Model

To fix "wrong notebook updated":

- Session starts with an explicit allowed notebook set.
- Every mutation must carry a `NotebookHandle` (`uri` + `revision`).
- Host rejects writes to notebooks outside the session allowlist.
- Host rejects stale writes when revision no longer matches.

No write operation can implicitly target "current notebook".

## Storage and IndexedDB

Low-level notebook persistence remains host-owned (`LocalNotebooks` /
`NotebookData` path). Sandbox code never accesses IndexedDB APIs directly.

## Existing Interfaces Review (Avoid Duplication)

This section documents existing notebook-related interfaces and why they are
not sufficient as the external sandbox contract in #154.

### `NotebookStore` (storage CRUD)

Location:

- `app/src/storage/notebook.ts` (`NotebookStore`, `NotebookStoreItem`)

What it provides:

- file-level load/save/list/create/rename/getMetadata by URI.

Why not sufficient as sandbox API:

- no cell-level operations (`updateCells`, `insert`, `remove`).
- no execution operations (`executeCells`).
- no open-notebook targeting model (for example "open docs only").
- no explicit revision in method signatures for mutation calls.
- current code path is also loosely typed for local store routing
  (`resolveStore` uses an unsafe cast), so using this directly as a stable
  sandbox contract would lock in technical debt.

Reuse plan:

- keep `NotebookStore` as a persistence backend abstraction.
- adapt it behind `NotebookDbCore` for read/write/revision plumbing.

### `NotebookSaveStore` (autosave hook)

Location:

- `app/src/lib/notebookData.ts` (`NotebookSaveStore`)

What it provides:

- minimal `save(uri, notebook)` for debounced autosave.

Why not sufficient as sandbox API:

- save-only; no load/list/query/handle lifecycle.
- no revision or conflict/cas semantics.
- no notion of notebook identity beyond raw URI string.

Reuse plan:

- keep it as an internal autosave seam for `NotebookData`.
- do not expose as sandbox-facing capability API.

### `NotebookContextValue` + `NotebookData` registry (UI layer)

Location:

- `app/src/contexts/NotebookContext.tsx`

What it provides:

- URI-keyed map of open `NotebookData` instances.
- `getNotebookData(uri)`, `useNotebookList()`, `useNotebookSnapshot(uri)`.

Why not sufficient as sandbox API:

- React/context/hook-oriented API, not transport-safe.
- coupled to client render lifecycle, not a durable RPC contract.
- does not provide revisioned handles.

Reuse plan:

- use this registry (or an extracted non-React service) on the host side to
  implement `HostNotebooksApi.list/get`.

### `NotebookData` / `NotebookDataLike` / `RunmeConsoleApi` (runtime helpers)

Location:

- `app/src/lib/notebookData.ts`
- `app/src/lib/runtime/runmeConsole.ts`
- `app/src/components/AppConsole/AppConsole.tsx` (`resolveNotebookData`)

What it provides:

- in-memory notebook model with mutation and run methods (`updateCell`,
  `appendCodeCell`, `removeCell`, `runCodeCell`, etc.).
- helper APIs that can target a notebook object or URI.

Why not sufficient as sandbox API:

- object-handle style (`NotebookDataLike`) is not a robust wire protocol.
- targeting can fall back to current/visible notebook, which is unsafe for
  asynchronous tool execution (tab-switch race).
- no explicit revision on mutating methods.

Reuse plan:

- `HostNotebooksApi` should reuse `NotebookData` as the mutation engine for
  open docs.
- sandbox calls should still use explicit `NotebookHandle { uri, revision }`
  and op-based updates.

### Existing Notebook Tool Schemas (`NotebookService`)

Location:

- `app/src/protogen/oaiproto/aisre/notebooks_pb.d.ts`
- runtime handlers in `app/src/components/ChatKit/ChatKitPanel.tsx`

What it provides:

- method shapes for `updateCells`, `getCells`, `listCells`, `executeCells`.

Why not sufficient as-is:

- handlers are currently ChatKit-panel specific and tied to `currentDocUri`.
- payloads are raw proto cell objects; this leaks low-level enum/detail burden
  to model code (one source of reliability issues in #154).
- not designed as a general sandbox kernel contract.

Reuse plan:

- reuse method intent and response semantics where possible.
- route through new SDK normalization and revisioned handles.
- keep compatibility adapters for existing ChatKit integrations.
- transitional direction: simplify agent-facing notebook tooling toward a
  single "execute JS" entrypoint, with notebook operations performed via SDK
  calls inside that execution path.

### Conclusion

We are not replacing existing notebook logic wholesale. We are:

- reusing `NotebookData` as host mutation/runtime authority for open docs,
- reusing storage backends via `NotebookDbCore` adapters,
- reusing existing tool semantics where possible,
- introducing a single `NotebooksApi` contract with separate host/sandbox
  implementations to fix correctness and safety gaps.

## How This Plugs Into Existing Code

### 1) `LocalNotebooks` becomes the default `NotebookDbCore` backend

Current:

- `LocalNotebooks` already owns IndexedDB state and checksum computation.
- `save/load/create/rename/getMetadata` exist today.

Planned:

- Add `getWithRevision(uri)` and `saveIfRevision(...)` helpers in
  `app/src/storage/local.ts` (or a thin adapter in
  `app/src/lib/appkernel/host/indexedDbCore.ts`).
- Reuse existing checksum field as revision token.

### 2) `NotebookData` remains the in-memory mutable model

Current:

- `NotebookData` mutates cell state and autosaves through `notebookStore.save`.

Planned:

- Keep this path for interactive UI editing.
- For sandbox execution, `HostNotebooksApi.update(...)` applies
  `NotebookMutation[]` against the
  canonical `NotebookData` instance, then persists through `NotebookDbCore`.
- `NotebookData` stays the source of truth for live open docs; `NotebookDbCore`
  is persistence + revision gate.

### 3) `NotebookContext` supplies open notebook registry

Current:

- `NotebookProvider` tracks open notebook list and URI->`NotebookData` map.

Planned:

- `HostNotebooksApi.list/get` target resolution uses `NotebookContext` data (or an
  extracted registry service) so targeting is explicit and tab-safe.
- This directly addresses wrong-notebook writes from implicit "current tab"
  behavior.

### 4) `runmeConsole` / helper APIs move to SDK over `NotebooksApi`

Current:

- `runmeConsole` and `appJsGlobals` call `NotebookData` directly and expose many
  helpers.

Planned:

- New notebook SDK calls `NotebooksApi` only.
- Existing helper methods that mutate notebooks are gradually reimplemented via
  SDK methods (for example `clearOutputs`, `runAll` orchestration remains, but
  cell edits route through `notebooks.update` operations).

### 5) `NotebookData.runCodeCell(...AppKernel...)` runtime swap

Current:

- AppKernel path executes in-process via `JSKernel` + `createAppJsGlobals`.

Planned:

- Replace in-process execution with sandbox runtime.
- Sandbox code imports notebook SDK; SDK talks to host via `NotebooksApi` RPC.
- Host bridge handlers call `HostNotebooksApi` (`NotebookDbCore` +
  `NotebookData` registry).

## Security Model (v0)

- No direct `fetch`/network capability exposed by sandbox API.
- No token or credential material returned to sandbox.
- No direct Drive capability in v0 sandbox surface.
- Default-deny for unknown API methods.
- Structured logs for every allowed/denied call.

## Integration Plan

1. Define shared `NotebooksApi` types and schemas (`app/src/lib/appkernel/api/*`).
2. Implement `HostNotebooksApi` on top of existing `NotebookData` +
   `NotebookDbCore`.
3. Implement `NotebooksApiBridgeServer` with policy + undo journal.
4. Implement `SandboxNotebooksApiClient` over `MessageChannel`.
5. Update `NotebookData` AppKernel path to execute via sandbox runtime (not
   direct `new Function(...)`).
6. Add compatibility shim so existing AppKernel tests can migrate incrementally.
7. Move notebook-mutating helper functions to SDK + `NotebooksApi` path and shrink
   direct mutation surface in `appJsGlobals`.
8. Update JS cell toolbar UX to show runner select (`browser`/`sandbox`) and
   route execution by runner name (`appkernel-js` vs
   `appkernel-js-sandbox`).

## Test Plan

- Unit tests:
  - SDK normalizes/validates cell kind and metadata inputs.
  - Primitive schema rejects invalid ops.
  - Policy blocks notebook out-of-scope writes.
  - Revision mismatch returns deterministic conflict.
- Integration tests:
  - sandbox session can list/read/update allowed open notebook.
  - switching active tab does not affect target notebook.
  - undo token restores pre-mutation notebook state.
  - no direct network APIs available in v0 sandbox contract.

## Open Questions

- Should v0 writes require explicit user approval per `update`, or rely on
  session-level approval?
- Should undo operate per operation, per `update` batch, or per execution?
- Do we want read-only Drive primitives (`drive.list`) in v0.1, or keep Drive
  fully outside sandbox until notebook flow is stable?

## References

- [Issue #154: Improve Codex Manipulation Of Notebooks](https://github.com/runmedev/web/issues/154)
- [Issue #55: Local Filesystem Storage for Notebooks (File System Access API)](https://github.com/runmedev/web/issues/55)
- [Issue #55 comment: unify/mirror discussion for `runme-local-notebooks`, `runme-fs-workspaces`, and `contents://`](https://github.com/runmedev/web/issues/55#issuecomment-4159045318)
- [Issue #157: consolidate notebook storage and remove `runme-fs-workspaces`](https://github.com/runmedev/web/issues/157)
