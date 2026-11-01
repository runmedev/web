---
name: logs-diagnostics-and-troubleshooting
title: Logs Diagnostics And Troubleshooting
order: 14
description: >-
  Use this guide when Runme appears unresponsive or notebook execution, runner
  connectivity, Drive, or authentication is failing. It identifies the first
  diagnostic surfaces, common failure classes, useful App Console probes, and
  a practical debugging order. Pair it with the affected subsystem's guide
  once the failure has been narrowed down.
---

# Logs Diagnostics And Troubleshooting

## First place to look

If notebook execution, Drive, or auth appears broken, open the document tabs
from the left navigation bar and inspect:

- `App Console` for current config and manual probes,
- `Logs` for runtime failures and warnings.

## Common failure classes

- no runner configured,
- backend endpoint wrong or unavailable,
- OIDC auth missing or expired,
- Drive auth missing or expired,
- notebook pending sync,
- Jupyter server or kernel not available.

## Useful probes

```js
runmeRunners.get()
runmeRunners.getDefault()
oidc.getStatus()
agent.get()
drive.listPendingSync()
help()
```

## Practical debugging order

1. Confirm the active surface is correct: notebook or document tab.
2. Confirm auth state.
3. Confirm runner selection.
4. Inspect logs.
5. Retry with the App Console rather than only clicking UI controls.

## Key facts

- Many user reports that look like notebook bugs are actually configuration bugs.
- Logs are part of the product's normal diagnostic story and should be referenced in support guidance.
- "Nothing happened" often means the action failed in a different subsystem than
  the visible pane the user is watching.

## SharedWorker storage diagnostics

Open **Logs → Storage worker** to select a live or previously recorded worker.
The panel shows its release, storage phase, persistence health, and structured
request events. Filter by severity, scope, or request ID. **Follow** polls for
new events; **Load next page** reads older retained events in sequence order.
Download exports the events currently loaded in the panel, not notebook content.

These diagnostics do not read IndexedDB or wait for notebook initialization.
The worker keeps a bounded memory buffer and asynchronously writes JSONL chunks
under `runme-diagnostics/storage-workers/v1` in this site's OPFS. Retention is
limited to seven days, 2 MiB per worker, and 20 MiB across workers, with additional
file-count limits. Events can be dropped under load or when storage is unavailable.
Logs stay in this browser profile and origin; they are not uploaded automatically.

For agents, use the read-only WebMCP tools `ListStorageWorkerSessions`,
`GetStorageWorkerStatus`, and `ReadStorageWorkerLogs`. These handlers bypass
ExecuteCode, its operation registry, and console-history hydration. The same
functions are available to JavaScript:

```js
const sessions = await runme.logs.listWorkerSessions({ timeoutMs: 1000 });
const instanceId = sessions.workers[0]?.instanceId ?? sessions.persisted[0]?.instanceId;
const page = await runme.logs.readWorkerLogs({ instanceId, limit: 100, timeoutMs: 2000 });
// Pass page.nextSequence as afterSequence for the next page.
```

A partial result identifies unavailable memory/OPFS sources and corrupt chunks.
A missing live reply means the worker's state is unknown: its event loop may be
stalled, it may have exited, or it may predate this protocol. Disk logs can still
be readable after exit. A timeout does not prove an operation failed or justify
retrying a notebook creation. Capture the request ID and last completed phase.

For explicit recovery, `runme.storageWorkers.restart({ instanceId,
mode: 'graceful', timeoutMs: 5000 })` asks that worker to drain and close.
`mode: 'force'` skips draining and can leave writes uncertain; it remains a
cooperative request and cannot terminate a frozen worker. The result distinguishes
`stopped` from `unknown`, and `replacementReady: false` means a replacement has
not been verified. The API never reloads tabs or repeats notebook mutations.
