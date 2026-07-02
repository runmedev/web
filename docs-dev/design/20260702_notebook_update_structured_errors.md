# Structured Errors for Bulk Notebook Updates

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

## Non-Goals

This change does not make `notebooks.update` fully transactional. It reports partial application. Existing local rollback inside `insert` remains in place for inserted cells created by a failed insert operation.

This change does not add per-operation success return values for successful updates. A successful update still returns `NotebookDocument`.

## Risks

The error may include caller-provided operation payloads in `failedOperation`. This is intentional for debugging, but the bridge must keep the payload JSON-safe.

The details describe operations applied by the update loop. If a single operation partially mutates before throwing and does not roll itself back, the failed operation is still reported as `failed`, not `applied`.
