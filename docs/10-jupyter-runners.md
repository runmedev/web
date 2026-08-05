---
name: jupyter-runners
title: Jupyter Runners
order: 10
description: >-
  Use this guide when notebook cells must execute through a Jupyter kernel. It
  covers Runme's kernel-management UI, direct lifecycle helpers, kernel
  selection, runner scoping, and troubleshooting. Use the AppKernel guide for
  browser JavaScript and the local Runme guide for WebSocket backend execution.
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

A kernel is identified by the pair `(runner name, kernel ID)`. The backend
assigns the kernel ID when it starts the process. Display names are optional,
browser-local aliases that make otherwise identical kernel specs easier to tell
apart; they are not substitutes for the kernel ID.

Multiple notebook cells can select the same kernel and share its variables,
imports, working state, and execution history. Starting another kernel creates
an isolated stateful session even when both kernels use the same spec.

## Manage kernels in the UI

1. Open **Notebook Runner Status** from the runner status button in the app
   toolbar.
2. Find the target runner and select **Manage kernels**. The action is disabled
   when that runner does not have an endpoint.
3. Use the runner-scoped kernel tab to inspect kernel name, full kernel ID,
   execution state, active connection count, and last activity.
4. Enter an allowlisted kernel spec, normally `python3`, and optionally a
   display name. Select **Start kernel**.
5. Use **Refresh** when another client or process may have changed the runner's
   kernels.

The lifecycle controls have these effects:

- **Restart** replaces the underlying kernel process while preserving its
  logical kernel ID. In-memory state is lost, but cells that selected that ID
  remain associated with the restarted kernel.
- **Stop** terminates the kernel and removes its ID from the runner. Cells that
  selected it must choose a running kernel before executing again.
- **Interrupt** cancels current kernel work without discarding kernel state. It
  is invoked automatically by notebook interruption and is also available
  through the App Console helper.

## Select a kernel for a cell

1. Set the cell language to **Jupyter**.
2. Choose a kernel from the kernel dropdown. The app lists kernels from all
   configured runners and stores both the runner name and kernel ID in cell
   metadata.
3. Reuse the same selection on multiple cells when they should share state, or
   select different kernel IDs for isolation.

If exactly one kernel is available, Runme selects it automatically. When
multiple kernels use the same spec, give them distinct display names in the
kernel-management tab or App Console.

## Useful App Console commands

```js
const analysis = await jupyter.kernels.start('default', {
  kernelSpec: 'python3',
  name: 'analysis',
})
jupyter.kernels.get('default')
jupyter.kernels.interrupt('default', analysis.id)
jupyter.kernels.restart('default', analysis.id)
jupyter.kernels.stop('default', analysis.id)
```

The helpers send authenticated requests through the configured runner. Prefer
them over raw `fetch` calls from notebook cells so the current OIDC token is
attached correctly.

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

## Direct runner API

Runme Web uses the following authenticated endpoints on each runner:

```text
POST   /v1/jupyter/kernels
GET    /v1/jupyter/kernels
GET    /v1/jupyter/kernels/{kernel_id}
DELETE /v1/jupyter/kernels/{kernel_id}
POST   /v1/jupyter/kernels/{kernel_id}/interrupt
POST   /v1/jupyter/kernels/{kernel_id}/restart
WS     /v1/jupyter/kernels/{kernel_id}/channels
```

These routes manage Runme-owned kernels directly. The old
`/v1/jupyter/servers/...` registry and proxy routes are not part of this model.

## Key facts

- A valid backend runner is required because it owns the kernel processes and
  performs WebSocket-to-ZeroMQ bridging.
- The web app authenticates kernel HTTP requests with the current OIDC ID token.
- The initial channels implementation supports Jupyter's JSON WebSocket
  messages. Binary buffers and the `v1.kernel.websocket.jupyter.org`
  subprotocol are rejected explicitly until binary protocol support is added.
- If the user says "Jupyter does not run," verify the runner endpoint and the
  direct kernel state; there is no separate Jupyter Server registry to inspect.
