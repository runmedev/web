# Surface Cell Execution Errors In Cell Output

- **Author:** Jeremy Lewi
- **Date:** 2026-07-29
- **Status:** Draft

## TL;DR

Runme Web currently logs some cell execution failures without showing them in
the cell. This affects attempts with no configured runner and runner protocol
negotiation failures such as an unsupported `OpenRunRequest`.

We will write these failures to the cell's stderr output and mark initial
execution attempts as completed with exit code `1`. Resume failures retain the
existing monitoring semantics: a missing run becomes `unknown`, while a
non-authoritative connection failure remains `running`.

## Problem

Running a backend cell can fail before the runner accepts the command:

1. No runner is configured.
2. The WebSocket connects, but runner protocol negotiation fails.
3. The runner rejects the execution request before reporting a PID.

`NotebookData.runCodeCell` currently logs the first case and returns an empty run
ID. `bindStreamsToCell` logs stream errors and only adds cell output for a
missing resumed run. The notebook therefore provides no visible explanation for
most initial execution failures.

The browser console and application logs are diagnostic surfaces. They are not
an acceptable substitute for cell output because the user initiated the action
from the cell.

## Requirements

- Show an actionable error in the output of the cell that failed to execute.
- Mark a rejected initial execution as completed with a nonzero exit code.
- Clear stale PID metadata when an initial execution fails.
- Preserve the runner's error message, including protocol parsing details.
- Preserve resume semantics from the execution monitoring design.
- Keep stdout and stderr output compatible with existing notebook renderers.

## Non-Goals

- Add a new runner protocol message.
- Treat a transport outage as proof that an already-started process failed.
- Replace application logs or runner diagnostics.
- Add a toast for execution failures.
- Change AppKernel or Jupyter error handling.

## Proposal

### No runner configured

When runner resolution fails, `runCodeCell` will:

1. close and remove any stream or Jupyter socket from the previous execution;
2. retain stateful terminal output and clear stale text output;
3. append `Runme backend server is not running. Please start it and try again.`
   as stderr;
4. set `runme.dev/exitCode` to `1`;
5. set `runme.dev/executionState` to `completed`;
6. clear stale `runme.dev/pid`, `runme.dev/lastRunID`, and
   `runme.dev/sequence`;
7. update and persist the cell;
8. return an empty run ID because no runner accepted the execution.

### Initial runner negotiation failure

`createAndBindStreams` will pass its `RunIntent` to `bindStreamsToCell`.

When a stream created with `RUN_INTENT_START` reports an error before reporting
a PID, the binder will:

1. extract the error's `message` field when available;
2. append `Cell execution failed: <message>` as stderr;
3. set exit code `1` and execution state `completed`;
4. clear the PID;
5. persist the cell and close the stream.

This includes protocol mismatches such as a runner rejecting an unknown
`openRunRequest` field.

### Resume failures

Resume behavior remains distinct because a connection error does not prove that
the remote process failed.

| Intent and progress   | Error                           | Cell state              | Cell output                             |
| --------------------- | ------------------------------- | ----------------------- | --------------------------------------- |
| `START`, before PID   | Any terminal stream error       | `completed`, exit `1`   | Execution error on stderr               |
| Any intent, after PID | Run not found                   | `unknown`, no exit code | Existing monitoring-interrupted warning |
| Any intent, after PID | Other connection/protocol error | `running`, no exit code | Existing output unchanged               |
| `RESUME`, before PID  | Other connection/protocol error | `running`, no exit code | Existing output unchanged               |

## UX

The error appears in the normal output area below the cell. It uses stderr so
the existing `ActionOutputItems` renderer applies the same presentation used
for command failures. The user does not need to open Logs or browser developer
tools.

The message identifies the failure and preserves the runner's detail:

```text
Cell execution failed: proto: unknown field "openRunRequest"
```

The no-runner case uses the existing actionable message:

```text
Runme backend server is not running. Please start it and try again.
```

## Implementation

- `app/src/lib/notebookData.ts`
  - add a helper that extracts a useful message from `Error` and
    `WebsocketStatus` values;
  - record a visible failure in the no-runner branch;
  - pass `RunIntent` into `bindStreamsToCell`;
  - record visible stderr and terminal metadata for `START` errors.
- `app/src/lib/notebookData.test.ts`
  - assert no-runner attempts write stderr and terminal failure metadata;
  - assert a `START` protocol error writes the runner message;
  - assert `RESUME` monitoring errors retain current behavior;
  - assert a missing resumed run still becomes `unknown`.

## Alternatives

### Show only a toast

We will not use a toast as the primary surface. Toasts disappear, are detached
from the failing cell, and are not persisted with the notebook.

### Mark every stream error as failed

We will not mark resume connection errors as failed. A running process can
survive a browser-to-runner transport outage. Synthesizing exit code `1` would
misrepresent an unknown remote outcome.

### Change `runCodeCell` to throw

We will not require UI callers to catch execution setup errors. The cell model
already owns outputs and execution metadata, and notebook automation also uses
this path. Recording the failure in the model gives every caller the same
result.

## Test Plan

### Automated

- Run focused `notebookData` tests.
- Run `runme run build test` as required by the repository.

### Browser

1. Start the development server.
2. Open a notebook with a backend code cell and no configured runner.
3. Execute the cell.
4. Verify the cell output shows the actionable no-runner error and the cell is
   not left running.
5. Reproduce a runner protocol rejection using the existing mismatched-runner
   notebook.
6. Verify the runner's protocol message appears in the failing cell.
7. Capture screenshots of both visible failure states.

## Validation

- `pnpm -C app exec vitest run src/lib/notebookData.test.ts`: 33 tests passed.
- `runme run build test`: build and repository test tasks passed.
- Browser no-runner reproduction: the cell showed the actionable backend
  message and completed with exit code `1`.
- Browser runner-rejection reproduction: the cell showed the runner's
  authorization error and completed with exit code `1`.
- The focused protocol test verifies that
  `proto: unknown field "openRunRequest"` is preserved in cell stderr.

## Risks

Persisting setup failures changes notebook content. This is intentional: output
from a user-initiated execution attempt should remain attached to the cell.

Runner messages may be technical. Preserving them is useful for protocol
failures, while the `Cell execution failed:` prefix gives the message context.
We can add stable user-facing mappings for common runner status codes later.
