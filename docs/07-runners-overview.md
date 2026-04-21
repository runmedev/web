# Runners Overview

## What a runner is

A runner is the execution backend used for code cells.

Runner configuration is persisted in browser storage and includes:

- name,
- endpoint or implicit runtime,
- reconnect behavior,
- default selection.

## Main runner families

- local Runme backend runners over WebSocket,
- AppKernel browser JavaScript runners,
- Jupyter kernels proxied through Runme.

## Canonical App Console commands

```js
runmeRunners.get()
runmeRunners.update("default", "ws://localhost:9977/ws")
runmeRunners.getDefault()
runmeRunners.setDefault("default")
runmeRunners.delete("default")
```

## Selection guidance

- use a local Runme runner for normal backend execution,
- use AppKernel for browser-native JavaScript execution,
- use Jupyter when a notebook must talk to a Jupyter server and kernel.

## High-value facts for Codex

- Many execution failures reduce to "wrong runner" or "no default runner."
- Runner config is user state, not repo state.
- AppKernel runner names are synthetic and do not require a backend WebSocket.
