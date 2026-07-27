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
