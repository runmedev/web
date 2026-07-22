# Cell Execution Monitoring Across Reconnects

- **Author:** Jeremy Lewi
- **Date:** 2026-07-15
- **Status:** Draft

## TL;DR

Runme Web can show a cell as running after its process has exited. The bug
occurs when the browser misses the exit response and reconnects with a `runID`
that the runner no longer knows. The old runner interprets the unknown `runID`
as a new execution and creates an empty multiplexer. That multiplexer answers
heartbeats but never produces an exit event.

We will add an `OpenRunRequest` as the first WebSocket application message. Its
intent is either `START` or `RESUME`. `RESUME` will attach only to an active run
and return `NOT_FOUND` rather than create a new one. The runner will retain its
legacy create-or-attach behavior for clients that do not send
`OpenRunRequest`.

This change restores active-run recovery after a browser refresh. It does not
retain completed results. If a run finishes while the browser is disconnected,
the client will record the outcome as `unknown`. Retaining terminal results is
a future protocol extension.

## Motivation

### Bug

Three cells in a local notebook remained in the running state after their
commands had finished. Each cell had:

- `runme.dev/lastRunID`
- `runme.dev/pid`
- no `runme.dev/exitCode`

The operating-system processes no longer existed. Clearing the persisted PIDs
removed the running indicators.

The failure is reproducible:

1. Start a backend cell execution.
2. Persist the PID and `runID`.
3. Disconnect the browser before it receives the exit response.
4. Let the process finish and let the runner remove the `runID`.
5. Reload the notebook and reconnect with the persisted `runID`.

The old runner uses one operation for two intents:

- an existing `runID` attaches the connection to its multiplexer;
- an unknown `runID` creates a multiplexer.

Step 5 therefore creates an empty multiplexer. Heartbeats succeed, but no
process is attached and no exit response will arrive. The cell remains active
indefinitely.

### Why the client cannot infer liveness

The client persists three observations:

- `lastRunID` identifies an execution attempt;
- `pid` records that the runner reported a process;
- `exitCode` records an observed terminal result.

A PID without an exit code does not prove that the process is still running.
PIDs are runner-local and can be reused. A heartbeat proves transport health,
not process liveness. A silence timeout is also unsafe because a valid process
can produce no output for hours.

After reconnecting, the client cannot distinguish:

1. an active but quiet process;
2. a process that finished while the client was disconnected;
3. a run lost because the runner restarted;
4. an empty multiplexer created for an expired `runID`.

The runner must resolve this ambiguity.

### Requirements

The design must:

- reconnect to an active execution after a browser refresh;
- never create a run when the client intends to resume;
- stop showing a cell as running when the resume target does not exist;
- preserve the existing behavior for legacy clients;
- avoid inventing a successful or failed exit code;
- distinguish the execution identifier from the WebSocket identifier.

This version does not retain completed results or survive loss of the runner's
in-memory run registry.

## Background

### Execution and connection identifiers

Runme uses different identifiers for an execution and for a connection to that
execution:

| Identifier | Scope                    | Lifetime                                                            |
| ---------- | ------------------------ | ------------------------------------------------------------------- |
| `runID`    | One command execution    | Stable from execution start through every reconnect                 |
| `streamID` | One WebSocket connection | Generated when the socket is opened and discarded when it is closed |

The web client generates `runID` as `run_<ULID>`. The runner uses it as the key
for the multiplexer that owns an execution. The client persists the value as
`runme.dev/lastRunID` so a reloaded notebook can refer to the same execution.

The client generates `streamID` as a UUID without dashes for each connection.
The runner uses it to add and remove that connection from the run's
multiplexer. One `runID` can therefore have several `streamID` values over its
lifetime, and more than one client can connect to the same run. Reconnecting
after a browser refresh means using the original `runID` with a new
`streamID`.

### Current WebSocket request

The web client opens the runner WebSocket with this URL shape:

```text
<runnerEndpoint>?id=<streamID>&runID=<runID>
```

`id` and `runID` are the only query arguments that the `Streams` client adds.
If the configured runner endpoint already contains other query arguments, the
client preserves them; it sets or replaces `id` and `runID`. The runner
requires both values before upgrading the connection.

After the upgrade, application messages contain `knownId`, `runId`, and, when
available, `authorization`. `knownId` identifies the notebook cell rather than
an execution. The proposed `OpenRunRequest.intent` is also an application
message field. None of these fields is added as a query argument. `runID` is
currently present both in the WebSocket URL and in application messages.

## Proposal

### Protocol

The WebSocket envelopes will add an explicit open-run exchange:

```proto
enum RunIntent {
  RUN_INTENT_UNSPECIFIED = 0;
  RUN_INTENT_START = 1;
  RUN_INTENT_RESUME = 2;
}

enum RunState {
  RUN_STATE_UNSPECIFIED = 0;
  RUN_STATE_CREATED = 1;
  RUN_STATE_RUNNING = 2;
}

message OpenRunRequest {
  RunIntent intent = 1;
}

message OpenRunResponse {
  RunState state = 1;
}
```

`OpenRunRequest` must be the first application message from a negotiating
client. The runner will validate authorization, `runID`, and `knownID` before
acting on the intent.

The client must wait for `OpenRunResponse` before sending execute requests or
heartbeats. A second `OpenRunRequest` on the same WebSocket will fail with
`FAILED_PRECONDITION`.

### Runner behavior

| Intent   | Runner state          | Result                                     |
| -------- | --------------------- | ------------------------------------------ |
| `START`  | `runID` is unknown    | Create it and return `CREATED`             |
| `START`  | `runID` exists        | Return `ALREADY_EXISTS`                    |
| `RESUME` | active `runID` exists | Attach to it and return `RUNNING`          |
| `RESUME` | `runID` is unknown    | Return `NOT_FOUND`; do not create anything |

After a successful `START`, later connections for the same client-side stream
will use `RESUME`.

If the first request is not `OpenRunRequest`, the runner will use the legacy
create-or-attach path. This preserves compatibility with clients that do not
know the new protocol.

### Web client behavior

Runme Web will persist `runme.dev/executionState`:

| State       | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| `running`   | The client has no authoritative terminal result.           |
| `completed` | The client observed an exit code.                          |
| `unknown`   | The runner reported that it no longer retains the `runID`. |

A new execution will send `START` and wait for `CREATED` before releasing its
queued execute request.

When a notebook is reloaded with a PID, `lastRunID`, and no exit code, the
client will send `RESUME` for the persisted `runID`:

- `RUNNING`: retain the PID and continue monitoring;
- `NOT_FOUND`: clear the PID, set `executionState=unknown`, preserve existing
  output, and append an explanatory warning;
- transport failure: retain the PID and `running` state and keep reconnecting.

`unknown` is not an exit status. The client will not synthesize exit code `0`
or `1`.

### Unreachable runners and user recovery

Connection failure is not a terminal execution result. The client will keep the
cell in the running state until it receives an exit response or the runner
returns `NOT_FOUND`. This can leave a cell running indefinitely when its runner
was on a VM that no longer exists, but it avoids turning a network outage into
a false execution result.

Users can select another runner and rerun the cell. The rerun creates a new
`runID` and stops monitoring the old one. If the old runner is unreachable, the
client cannot guarantee that its process stopped, so users must treat
non-idempotent commands carefully.

A future UI should let users explicitly abandon an unreachable run. Abandoning
will clear local running state and record `unknown`; it will not claim that the
remote process was cancelled. Confirmed remote cancellation requires a runner
connection and a separate cancellation acknowledgement, which this protocol
does not add.

### Browser refresh during a long execution

Consider a ten-hour command followed by a browser refresh after five hours.
The reloaded notebook opens a WebSocket with a new `streamID` and sends
`RESUME` for the original `runID`.

If the runner still owns the execution, it returns `RUNNING` and attaches the
new connection to the existing multiplexer. The browser resumes monitoring the
same process without executing the command again.

If the run finished while the browser was disconnected, the runner has already
removed it and returns `NOT_FOUND`. The browser records `unknown` rather than
displaying false liveness.

### Compatibility and rollout

Backward compatibility is runner-side:

| Client     | Runner | Behavior                               |
| ---------- | ------ | -------------------------------------- |
| Legacy     | New    | Existing create-or-attach behavior     |
| Negotiated | New    | Explicit `START` and `RESUME` behavior |
| Negotiated | Legacy | Unsupported                            |

We will deploy the runner before the web client:

1. Deploy the runner with negotiation and the legacy fallback.
2. Verify existing clients still execute and reconnect.
3. Deploy the negotiating web client.

The web client currently serializes the small negotiation envelope directly
because the published Buf package does not contain the new schema. It will use
the generated message types after the runner proto is published.

### Validation

Runner tests verify:

- `START` creates a run and returns `CREATED`;
- duplicate `START` returns `ALREADY_EXISTS`;
- `RESUME` attaches to an active run and returns `RUNNING`;
- missing `RESUME` returns `NOT_FOUND` without creating a run;
- legacy first messages retain create-or-attach behavior;
- existing round-trip and inactivity behavior remains intact.

Web tests verify:

- `START` is the first message;
- execute requests remain queued until `CREATED`;
- persisted running metadata sends `RESUME` with the saved `runID`;
- `NOT_FOUND` becomes a terminal monitoring error;
- `NOT_FOUND` sets `unknown`, clears the PID, and preserves an explanatory
  stderr output;
- transport failures preserve the PID and running state while reconnecting;
- callers waiting for the run resolve when monitoring becomes `unknown`.

### Future terminal-state retention

A later protocol version should retain a bounded terminal snapshot containing
at least `runID`, state, PID, and exit code. `RESUME` could then return
`COMPLETED` when the process finished during disconnection.

Output replay is useful but not required to resolve liveness. Retention limits,
runner restarts, and snapshot persistence require a separate design.

## Alternatives

### Put intent in the WebSocket query

An old runner could ignore an unknown query parameter and retain the ambiguous
behavior. A first application message requires an explicit response or an
explicit protocol failure.

### Mark persisted executions `unknown` without reconnecting

This client-only fix prevents false liveness but abandons active executions
after a browser refresh. Explicit `RESUME` preserves recovery without allowing
an unknown run to be created.

### Check the PID from the browser

The PID belongs to the runner host. The browser cannot inspect it portably, and
PID reuse can produce false positives.

### Use a quiet-period timeout

A long-running command may be silent indefinitely. Silence is not a terminal
protocol event.

### Mark an interrupted execution successful or failed

A missing exit response supports neither conclusion. Synthesizing exit code
`0` or `1` would corrupt execution history.

### Keep the implicit reconnect behavior

The old behavior creates an empty multiplexer for an unknown `runID`.
Successful heartbeats from that multiplexer do not prove that the original
process exists.

## References

- [Runner protocol draft PR](https://github.com/runmedev/runme/pull/1247) —
  adds `OpenRunRequest`, implements negotiated runner behavior, and covers
  start, resume, error, and legacy paths.
- [Runme Web draft PR](https://github.com/runmedev/web/pull/282) — implements
  client negotiation, persisted-run recovery, execution-state repair, and web
  regression tests.
- [WebSocket protocol schema](https://github.com/runmedev/runme/blob/codex/run-intent-negotiation/api/proto/runme/stream/v1/websockets.proto) —
  defines the `RunIntent`, `RunState`, `OpenRunRequest`, and `OpenRunResponse`
  wire types.
- [Web stream implementation](https://github.com/runmedev/web/blob/codex/fix-stale-cell-execution/packages/renderers/src/streams.ts) —
  sends the negotiation request and gates heartbeat and execution traffic on
  the response.
- [Notebook execution state implementation](https://github.com/runmedev/web/blob/codex/fix-stale-cell-execution/app/src/lib/notebookData.ts) —
  restores persisted runs with `RESUME` and records `unknown` after terminal
  monitoring failures.
- [Stale cell execution investigation notebook](https://drive.google.com/file/d/1OTZffhR0d2GX2x5gVJ43qiIHa7bTfUkX/view) —
  summarizes the observed failure, selected protocol fix, refresh behavior,
  and implementation links.
- [Codex investigation and implementation thread](codex://threads/019f4dd8-eff5-7dd1-be50-392508c916b0) —
  records the protocol discussion, compatibility analysis, implementation,
  and validation.
