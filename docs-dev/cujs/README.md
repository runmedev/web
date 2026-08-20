# Critical User Journeys (CUJs)

This directory is the source of truth for scenario-driven UX testing.

Each CUJ markdown file describes a user-visible workflow with machine-verifiable
acceptance criteria. Automation scripts should reference CUJs
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
- `jupyter.md` — minimal Jupyter integration flow:
  - start local Jupyter Server with `jupyter server --no-browser`,
  - configure Jupyter runner via Runme proxy,
  - run one Python cell,
  - verify expected stdout is rendered in the notebook.
- `direct-drive-notebook-creation.md` — direct Drive-backed creation flow:
  - create the authoritative file in a mounted Google Drive folder,
  - initialize its editable local mirror,
  - verify Explorer shows exactly one notebook entry.

## How CUJs are executed

- Scripted runner(s) live under `app/test/browser/`.
- `run-cuj-scenarios.ts` is the canonical orchestrator that executes all implemented
  CUJ scripts.
- CI can execute CUJs in two modes:
  - **presubmit** (on PR updates)
  - **postsubmit** (on `main` updates)

## Video and artifact expectations

CI should produce these outputs for each CUJ:

1. pass/fail summary with machine-verifiable assertions,
2. screenshots and snapshots,
3. a short walkthrough video (or GIF/MP4 fallback) uploaded to the PR/issue.
