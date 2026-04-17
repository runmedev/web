# AI Chat And ChatKit

## Purpose

The AI side panel provides conversational assistance inside the notebook app.

Typical uses:

- ask questions about the current notebook or workflow,
- trigger notebook-aware tools,
- use starter prompts for setup or investigation tasks.

## UI entry point

Open the `AI Chat` panel from the left toolbar.

## Important behavior

- the panel is notebook-aware,
- it can route through different harness backends,
- some backends require login or extra configuration before the first useful response.

## Starter prompt categories already present in the UI

- local runner setup,
- metrics or plotting style tasks,
- incident or runbook lookup style tasks.

## High-value facts for Codex

- The AI panel is not a generic detached chatbot. It is coupled to notebook and
  runtime helpers.
- "ChatKit" describes the UI protocol surface, but the actual backend can be
  `responses-direct`, `codex`, or `codex-wasm`.
- If AI appears broken, inspect harness selection and auth before debugging the
  notebook UI itself.
