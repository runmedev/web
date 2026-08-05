---
name: jupyter-runners
title: Jupyter Runners
order: 10
description: >-
  Use this guide when notebook cells must execute through a Jupyter kernel. It
  covers Runme's direct kernel lifecycle helpers, selection guidance, and
  user-visible behavior. Use the AppKernel guide for browser JavaScript and the
  local Runme guide for WebSocket backend execution.
---

# Jupyter Runners

## Purpose

Jupyter integration lets the web app execute cells through kernels owned by the
configured Runme runner. Runme bridges the browser channels WebSocket directly
to the kernel's ZeroMQ channels; a separate Jupyter Server is not required.

## Practical model

The app treats Jupyter as a runner-backed execution family. Each runner exposes
its own kernel collection at `/v1/jupyter/kernels`, and kernel IDs are scoped to
that runner.

## Useful App Console commands

```js
jupyter.kernels.start('default', { kernelSpec: 'python3' })
jupyter.kernels.get('default')
jupyter.kernels.interrupt('default', 'kernelId')
jupyter.kernels.restart('default', 'kernelId')
jupyter.kernels.stop('default', 'kernelIdOrName')
```

## When to use Jupyter

- Python notebooks,
- notebook kernels that need Jupyter semantics,
- environments exposed by an allowlisted kernel profile on the Runme runner.

## User-visible behavior

- stdout and errors may be translated from Jupyter protocol messages,
- the kernel dropdown lists live kernels from each configured runner,
- starting a kernel immediately refreshes the dropdown cache,
- kernel lifecycle matters separately from notebook tabs,
- misconfiguration can look like execution failure even when the UI itself is healthy.

## Key facts

- A valid backend runner is required because it owns the kernel processes and
  performs WebSocket-to-ZeroMQ bridging.
- The web app authenticates kernel HTTP requests with the current OIDC ID token.
- If the user says "Jupyter does not run," verify the runner endpoint and the
  direct kernel state; there is no separate Jupyter Server registry to inspect.
