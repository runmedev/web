---
name: local-runme-runners
title: Local Runme Runners
order: 8
description: >-
  Use this guide to configure or troubleshoot a local Runme backend connected
  over WebSocket. It covers the canonical endpoint setup, when a backend runner
  is appropriate for shell or server-side execution, expected UI behavior, and
  common connectivity failures. For browser-only JavaScript or Jupyter
  kernels, use the corresponding runner guide.
---

# Local Runme Runners

## Purpose

A local Runme runner is the standard backend execution path for shell-style or
server-backed notebook execution.

## Canonical setup

```js
runmeRunners.ensure('default', 'ws://localhost:9977/ws', { setDefault: true })
```

Adjust the endpoint to match the actual Runme agent port and host.

## What users should expect

- code cells execute through the backend,
- terminal-style stdin and stdout can flow through the cell console,
- auth interceptors may be attached automatically by the app.

## When to use this runner

- backend shell commands,
- integrations that require the Runme agent,
- normal non-AppKernel notebook execution.

## Common failure modes

- backend not running,
- wrong WebSocket URL,
- no default runner,
- auth or proxy mismatch.

## Key facts

- If a user says "run bash," start by checking the configured backend runner.
- The current docs and older examples may mention `app.runners.*`; the current
  App Console namespace is `runmeRunners.*`.
- Prefer `runmeRunners.ensure(...)` when the goal is "make sure this runner is
  configured and default".
