# Critical User Journeys (CUJs)

This directory is the source of truth for scenario-driven UX testing.

Each CUJ markdown file describes a user-visible workflow with machine-verifiable
acceptance criteria. Automation scripts and Codex prompts should reference CUJs
from `docs-dev/cujs/`.

## Current CUJs

- `hello-world-local-notebook.md` — baseline notebook flow:
  - configure local runner,
  - open local notebook,
  - run bash cell,
  - verify `hello world` output.
- `appkernel-javascript-notebook.md` — AppKernel notebook flow:
  - select `AppKernel (browser JS)` runner,
  - run JavaScript cells in-browser,
  - verify stdout/stderr and exit metadata updates in notebook outputs.
- `ai.md` — assistant interaction flow:
  - open ChatKit panel,
  - configure assistant harness in App Console,
  - type and send a message to the assistant,
  - verify the assistant response is visible in the panel.
- `jupyter.md` — minimal Jupyter integration flow:
  - start local Jupyter Server with `jupyter server --no-browser`,
  - configure Jupyter runner via Runme proxy,
  - run one Python cell,
  - verify expected stdout is rendered in the notebook.

## How CUJs are executed

- Scripted runner(s) live under `app/test/browser/`.
- `run-cuj-scenarios.ts` is the canonical orchestrator that executes all implemented
  CUJ scripts.
- CI can ask Codex to execute CUJs in two modes:
  - **presubmit** (on PR updates)
  - **postsubmit** (on `main` updates)

## Video and artifact expectations

When Codex is triggered from CI, request these outputs for each CUJ:

1. pass/fail summary with machine-verifiable assertions,
2. screenshots and snapshots,
3. a short walkthrough video (or GIF/MP4 fallback) uploaded to the PR/issue.
