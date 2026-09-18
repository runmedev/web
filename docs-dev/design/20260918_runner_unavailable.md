# Unavailable runner diagnostics

## Problem

A configured endpoint can exist in browser settings even though its runner is
stopped or deleted. `Streams` retries transport failures indefinitely, preserving
execution monitoring, but suppresses terminal errors during reconnect. A cell
therefore showed a blank terminal and enabled stdin with no explanation.

## Design

Expose replayable transport state (`connecting`, `connected`, `unavailable`,
`closed`) from `Streams`. `CellConsole` subscribes with `useSyncExternalStore`,
so a late-mounted view immediately sees the current state. A red, accessible
alert in the cell gives recovery instructions. Stdin is hidden and terminal
keystrokes are rejected while the transport is not connected.

A transport error or close reports unavailable immediately. A 10-second notice
timer covers sockets and protocol negotiations that stall without an error. It
only changes the diagnostic: it does not cancel authentication, synthesize an
execution result, or stop a connection that could still recover. Successful
OpenRun negotiation clears the notice; merely opening the WebSocket does not.
Every socket teardown clears its timer. Close-only failures retry too; a normal
execution exit has already removed socket listeners during cleanup.

Transport availability is **not execution state**. Preserve run IDs, PIDs,
outputs, START/RESUME negotiation, and automatic reconnect. Queued execution
continues when the runner returns, and the UI says so explicitly. A network
failure cannot prove that an existing process exited. Never serialize these
transient notices as stderr or `execution.finish` records. With reconnect
disabled, terminal transport errors still use the existing execution-error path,
now with a readable message rather than a raw browser Event.

This extends [execution monitoring](20260715_execution_monitoring.md) and
[cell execution errors](20260729_cell_execution_errors.md). It does not alter
AppKernel or Jupyter execution.

## Regression coverage

- Transport tests: immediate failure, replay to late subscribers, successful
  START/RESUME negotiation, stalled connect/handshake notices, close-only
  failures with and without reconnect, and timer cleanup.
- Cell tests: warning visibility, preserved output and PID, no fabricated exit
  code, blocked disconnected stdin, and normal input after reconnect.
- [Browser CUJ](../cujs/runner-unavailable.md): actual refused connection followed
  by a real runner start, queued execution, stdin, stdout, and exit status.
