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
- Codex or assistant workflows that need browser-native helper APIs.

## Important differences from backend runners

- no backend WebSocket runner is required,
- browser APIs and app-provided helpers can be exposed directly,
- sandbox policy differs between browser and sandbox variants.

## High-value facts for Codex

- AppKernel is the natural home for browser-side helper APIs like `opfs`,
  `net`, `runme`, and `notebooks`.
- "Browser JS" and "sandbox JS" are related but not interchangeable. The latter
  exists to tighten execution boundaries.
- If the user wants fast local notebook manipulation without backend setup,
  AppKernel is often the right first choice.
