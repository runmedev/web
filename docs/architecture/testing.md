# Testing Architecture

This document describes how testing is organized in this repository and how we
run Critical User Journey (CUJ) testing.

## Goals

The testing strategy balances three needs:

1. Fast feedback for code changes.
2. Reliable regression detection for core user workflows.
3. Human-reviewable artifacts (screenshots/videos) for UX changes.

## Test layers

### 1) Unit/component tests (fast, deterministic)

- Framework: Vitest.
- Typical scope: isolated functions and React components.
- Example location: `packages/react-console/src/components/__tests__/`.

These tests are expected to run on every PR and are the first quality gate.

### 2) Build validation

- Build order follows package dependencies:
  1. `renderers`
  2. `react-console`
  3. `app`
- The repo build validates that all packages compile and bundle correctly.

### 3) Browser integration tests (workflow-oriented)

- Location: `app/test/browser/`.
- Driver: `agent-browser` (snapshot, click/type, eval, screenshot).
- Purpose: validate realistic flows through the UI and backend integration.

## CUJ (Critical User Journey) testing

### Source of truth

CUJs are defined in markdown under `docs/cujs/`.

Each CUJ file includes:

- Preconditions (services/tools that must be running).
- User journey steps.
- Machine-verifiable acceptance criteria.

Current baseline CUJ:

- `docs/cujs/hello-world-local-notebook.md`

### Execution model

- Scenario scripts are implemented in `app/test/browser/`.
- `app/test/browser/run-cuj-scenarios.sh` is the orchestration entrypoint.
- Each script should produce assertion logs and test artifacts in
  `app/test/browser/test-output/`.

### Assertion philosophy

Prefer machine-verifiable checks only:

- DOM/snapshot assertions (`agent-browser snapshot -i`)
- explicit text checks
- deterministic JS evaluation (`agent-browser eval`)

Avoid assertions that require subjective manual judgment.

## CI and automation

### Standard CI tests

The existing `Test` workflow performs install/build/test for regular code quality
checks.

### Codex-triggered CUJ automation

Workflow: `.github/workflows/codex-cuj.yaml`

It requests Codex CUJ execution in two modes:

1. **Presubmit** (`pull_request_target`)
   - posts a deduplicated `@codex` request in the PR thread.
   - asks Codex to run `app/test/browser/run-cuj-scenarios.sh`.

2. **Postsubmit** (`push` to `main`)
   - comments on a tracking issue for main-branch CUJ runs.
   - asks Codex to run all CUJs against the merged commit.

Both requests ask for:

- per-CUJ pass/fail summaries,
- screenshots and logs,
- a short walkthrough video uploaded to the PR/issue.

## Artifacts and reporting

For CUJ runs, capture the following per scenario:

- terminal/assertion summary,
- snapshots and screenshots,
- short video clip (or GIF/MP4 fallback where tooling limits apply).

Artifacts should be attached in the PR/issue where Codex was triggered so
reviewers can quickly validate UI behavior and regressions.

## Adding a new CUJ

1. Add a scenario doc in `docs/cujs/<name>.md`.
2. Implement or extend a browser script under `app/test/browser/`.
3. Register the script in `app/test/browser/run-cuj-scenarios.sh`.
4. Ensure assertions are machine-verifiable.
5. Update docs if command names/flows changed.
