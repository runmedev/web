---
name: appkernel-browser-runners
title: AppKernel Browser Runners
order: 9
description: >-
  Use this guide for JavaScript execution that should stay inside the browser,
  including the standard and sandbox AppKernel runtimes. It explains when
  AppKernel is the right choice and how its lifecycle, capabilities, and
  limitations differ from backend Runme runners. It is not the guide for
  Jupyter kernels or shell execution on a local backend.
---

# AppKernel Browser Runners

## Purpose

AppKernel runners execute JavaScript in the browser instead of sending work to a
backend runner.

Current runner identities:

- `appkernel-js`: browser JS,
- `appkernel-js-sandbox`: sandbox JS.

## When to use AppKernel

- quick browser-local JavaScript execution,
- notebook-aware automation that should stay inside the web app,
- browser-local automation that needs notebook and app helper APIs.

## Important differences from backend runners

- no backend WebSocket runner is required,
- browser APIs and app-provided helpers can be exposed directly,
- sandbox policy differs between browser and sandbox variants.

## Key facts

- AppKernel is the natural home for browser-side helper APIs like `opfs`,
  `net`, `runme`, and `notebooks`.
- "Browser JS" and "sandbox JS" are related but not interchangeable. The latter
  exists to tighten execution boundaries.
- Trusted browser AppKernel cells can manipulate and execute notebooks.
- Sandbox AppKernel and WebMCP `ExecuteCode` can inspect notebooks but cannot
  use the general-purpose notebook mutation or execution methods. This prevents
  sandboxed code from using the host as an execution deputy.
