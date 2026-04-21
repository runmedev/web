# Jupyter Runners

## Purpose

Jupyter integration lets the web app execute cells through a Jupyter server and
kernel via the Runme proxy path.

## Practical model

The app treats Jupyter as a runner-backed execution family, but kernel lifecycle
is managed separately from normal backend runner configuration.

## Useful App Console commands

```js
jupyter.servers.get("default")
jupyter.kernels.start("default", "serverName", { kernelSpec: "python3" })
jupyter.kernels.get("default", "serverName")
jupyter.kernels.stop("default", "serverName", "kernelIdOrName")
```

## When to use Jupyter

- Python notebooks,
- notebook kernels that need Jupyter semantics,
- environments already managed by a Jupyter server.

## User-visible behavior

- stdout and errors may be translated from Jupyter protocol messages,
- kernel lifecycle matters separately from notebook tabs,
- misconfiguration can look like execution failure even when the UI itself is healthy.

## High-value facts for Codex

- A valid backend runner is usually still part of the setup story because the
  Runme proxy sits between the web app and Jupyter.
- If the user says "Jupyter does not run," verify both the runner endpoint and
  the Jupyter server/kernel state.
