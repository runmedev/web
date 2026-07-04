# Structured Errors for Bulk Notebook Updates

## Background

Runme exposes notebook automation through AppKernel JavaScript. The sandbox design
splits notebook behavior into one `NotebooksApi` contract with two
implementations:

- a host implementation backed by the live notebook model
- a sandbox client implementation that forwards calls to the host

Sandboxed AppKernel code runs in an iframe with a narrow helper surface. It does
not receive direct access to host objects. Instead, helpers such as
`notebooks.update(...)` call the host over a `MessageChannel` RPC path:

```ts
{ type: 'host-call', callId, method: 'notebooks.update', args }
```

The host validates the method against an allowlist, dispatches the call to the
real host implementation, and replies with either:

```ts
{
  type: ('host-result', callId, result)
}
```

or:

```ts
{
  type: ('host-error', callId, error)
}
```

The `callId` maps each host reply back to the pending sandbox-side promise.
Successful notebook results already flow through JSON-safe serialization before
they cross back into the sandbox.

WebMCP reuses this path. Runme registers an `ExecuteCode` browser tool. Codex
calls that tool through the claimed Chrome tab, Runme executes the supplied code
in AppKernel sandbox mode, and the tool returns the merged stdout/stderr output.
This proposal does not add a WebMCP-specific notebook API or a new transport.
It changes how the existing sandbox host bridge represents host-side errors.

## Problem

`notebooks.update` accepts multiple operations and applies them sequentially. If operation `K + 1` fails after the first `K` operations have mutated the notebook, the promise rejects with a plain `Error`. The caller receives a message, but not a structured answer to:

- which operations were applied
- which operation failed
- which operations were not attempted
- which notebook revision represents the partial state

This is especially hard for Codex-driven WebMCP flows. Code executed through AppKernel crosses a sandbox host bridge. That bridge currently serializes host failures as `String(error)`, so custom fields on host-side errors are lost before Codex can inspect them.

## Motivation

Bulk updates are useful because Codex can make a multi-cell edit with one optimistic revision check. The failure mode must still be inspectable. If a later operation fails, Codex needs enough detail to decide whether to re-read the notebook, retry only the remaining operations, or report a partial edit.

The API should not imply transactional behavior when the implementation is not fully transactional. It should state what happened.

## Proposal

`notebooks.update` will throw `NotebookUpdateError` when an operation inside a bulk update fails. The error will include a JSON-safe `details` object.

```ts
type NotebookUpdateOperationStatus =
  | { index: number; status: 'applied' }
  | { index: number; status: 'failed'; error: string }
  | { index: number; status: 'not_attempted' }

type NotebookUpdateErrorDetails = {
  method: 'notebooks.update'
  code: 'NOTEBOOK_UPDATE_FAILED'
  failedOperationIndex: number
  failedOperation: unknown
  failedOperationError: string
  appliedOperationCount: number
  operationStatuses: NotebookUpdateOperationStatus[]
  beforeHandle: NotebookHandle
  afterHandle: NotebookHandle
}

class NotebookUpdateError extends Error {
  name: 'NotebookUpdateError'
  code: 'NOTEBOOK_UPDATE_FAILED'
  details: NotebookUpdateErrorDetails
}
```

The update loop stops at the first failed operation. Operations before the failed index are marked `applied`. The failed operation is marked `failed`. Later operations are marked `not_attempted`.

The error includes `beforeHandle` and `afterHandle`. `beforeHandle` is the revision checked before mutation starts. `afterHandle` is the revision after the failure and any local rollback performed by the failed operation. Callers that need full state can call `notebooks.get({ handle: error.details.afterHandle })`.

## Validation Failures

Pre-apply validation errors use the same error shape. They report `appliedOperationCount: 0`, mark the invalid operation as `failed`, and mark every other operation as `not_attempted`.

This preserves fail-closed behavior for invalid insert cell kinds while still giving callers the failed operation index.

## WebMCP and AppKernel Surfacing

The sandbox host bridge will send structured host errors instead of only `String(error)`.

```ts
type SerializedHostError = {
  name: string
  message: string
  code?: string
  details?: unknown
}
```

When host-side `notebooks.update` throws `NotebookUpdateError`, the bridge posts:

```ts
{
  type: "host-error",
  callId,
  error: {
    name: "NotebookUpdateError",
    message,
    code: "NOTEBOOK_UPDATE_FAILED",
    details
  }
}
```

The sandbox reconstructs an `Error`, then attaches `name`, `code`, and `details`. Code executed by Codex via WebMCP can inspect the error directly:

```ts
try {
  await notebooks.update({ target, operations })
} catch (error) {
  if (error?.code === 'NOTEBOOK_UPDATE_FAILED') {
    console.log(error.details.failedOperationIndex)
    console.log(error.details.operationStatuses)
  }
}
```

Uncaught errors still render as stderr text. Structured details are available when Codex catches the error in the executed JavaScript.

## Alternatives

### Deserialize into concrete error classes

The bridge could serialize a class discriminator and reconstruct concrete error
classes in the sandbox, for example turning a host-side
`NotebookUpdateError.toJSON()` payload back into a sandbox-side
`NotebookUpdateError` instance.

We will not do that now.

Cross-realm JavaScript does not preserve prototypes reliably. The sandbox also
does not need `instanceof NotebookUpdateError` or class methods. It needs stable
machine-readable fields. A class registry would add versioning, fallback, and
trust-boundary concerns for little immediate value.

The bridge should treat errors as JSON data transfer objects:

```ts
type SerializedHostError = {
  name: string
  message: string
  code?: string
  details?: unknown
}
```

Callers should branch on stable fields such as `error.code` and then inspect
`error.details`. Unknown error codes still behave as ordinary `Error` instances
with a message.

### Rely only on native JSON serialization

The bridge could rely on `JSON.stringify(error)` or structured clone behavior
for host errors.

We will not rely on that. Native `Error` properties are not consistently
enumerable, and class-specific fields can be dropped or reshaped when crossing
realms. The bridge should explicitly copy the fields it promises to preserve:
`name`, `message`, `code`, and `details`.

### Define a generic payload serialization framework

The bridge could introduce a full serialization framework for all payloads,
including type tags, schema versions, and class rehydration.

That is too broad for this change. Successful host results already use JSON-safe
payloads, and the current issue is limited to preserving structured error
metadata. If more host APIs need typed error contracts, we can promote
`SerializedHostError` into a shared bridge protocol type and add documented error
codes without adding class rehydration.

## Non-Goals

This change does not make `notebooks.update` fully transactional. It reports partial application. Existing local rollback inside `insert` remains in place for inserted cells created by a failed insert operation.

This change does not add per-operation success return values for successful updates. A successful update still returns `NotebookDocument`.

## Risks

The error may include caller-provided operation payloads in `failedOperation`. This is intentional for debugging, but the bridge must keep the payload JSON-safe.

The details describe operations applied by the update loop. If a single operation partially mutates before throwing and does not roll itself back, the failed operation is still reported as `failed`, not `applied`.

## References

- [0310 AppKernel Sandbox](./20260311_appkernel_sandbox.md) defines the
  sandboxed AppKernel execution model, the `NotebooksApi` host/sandbox split, and
  the host broker policy boundary.
- [Code Mode](./20260331_code_mode.md) describes `ExecuteCode`, the shared
  AppKernel executor, and the Codex transport path.
- [WebMCP Tool Support](./20260510_webmcp.md) describes the WebMCP `ExecuteCode`
  registration and its reuse of the AppKernel sandbox executor.
- [Codex Chrome And WebMCP](../../docs/codex-chrome-webmcp.md) describes the
  external Codex desktop path that claims a Chrome tab and uses Runme WebMCP
  tools.
- [Agentic Search And Codex](../../docs/12-agentic-search-and-codex.md) contrasts
  in-app chat with external Codex through Chrome and WebMCP.
- [`sandboxJsKernel.ts`](../../app/src/lib/runtime/sandboxJsKernel.ts) implements
  the sandbox iframe, `MessageChannel` bridge, `host-call`, `host-result`, and
  `host-error` handling.
- [`codeModeExecutor.ts`](../../app/src/lib/runtime/codeModeExecutor.ts) builds
  the sandbox AppKernel runtime and dispatches sandbox host calls.
- [`notebooksApiBridge.ts`](../../app/src/lib/runtime/notebooksApiBridge.ts)
  routes sandbox notebook API calls to the host notebook API.
- [`runmeConsole.ts`](../../app/src/lib/runtime/runmeConsole.ts) defines
  `NotebooksApi`, `NotebookUpdateError`, and the bulk update application loop.
