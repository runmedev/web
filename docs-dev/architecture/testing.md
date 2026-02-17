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

CUJs are defined in markdown under `docs-dev/cujs/`.

Each CUJ file includes:

- Preconditions (services/tools that must be running).
- User journey steps.
- Machine-verifiable acceptance criteria.

Current baseline CUJ:

- `docs-dev/cujs/hello-world-local-notebook.md`

### Execution model

- Scenario driver scripts are implemented in `app/test/browser/` and are written in TypeScript.
- `app/test/browser/run-cuj-scenarios.ts` is the canonical orchestration entrypoint (with a shell wrapper kept for compatibility).
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

### CUJ automation modes

Workflow: `.github/workflows/app-tests.yaml`

The canonical entrypoint is `app/test/browser/run-cuj-scenarios.ts`.
GHA should contain minimal glue logic; orchestration and publishing behavior
should live in the TypeScript runner so the same flow works in CI and locally.

CUJ automation is supported in three modes:

1. **Local iteration**
   - run locally via `pnpm -C app run cuj:run`,
   - produces the same artifacts and movie output under
     `app/test/browser/test-output/`,
   - can upload artifacts to GCS when local credentials/permissions are available,
   - enables fast AI-assisted iteration without waiting on GHA.

2. **Presubmit** (`pull_request`)
   - runs CUJs for PR updates,
   - uploads `app/test/browser/test-output/*` to a world-readable GCS bucket,
   - publishes a commit status check (`app-tests`) whose target URL points to
     the run `index.html` in GCS.

3. **Postsubmit** (`push` to `main`)
   - runs the same CUJ driver against `main`,
   - uploads the same artifact set to GCS,
   - publishes the same status-check link pattern for the commit.

All modes produce per-CUJ status, screenshots, text snapshots/logs, and a short walkthrough video.

## Artifacts and reporting

For CUJ runs, capture the following per scenario:

- terminal/assertion summary,
- snapshots and screenshots,
- short video clip (or GIF/MP4 fallback where tooling limits apply).

### Publication policy (GCS)

To avoid zip-download-only UX from GitHub Actions artifacts, CUJ artifacts are
published to Google Cloud Storage and linked directly.

1. **Bucket accessibility**
   - Use a dedicated, world-readable bucket for CUJ artifact files.
   - Artifact URLs should be plain HTTPS object links that humans and reviewer
     AIs can open directly.

2. **Write access from CI and local runs**
   - Grant write access to the dedicated service account used by the CUJ
     workflow and to trusted local principals as needed for local iteration.
   - Prefer GitHub OIDC + Workload Identity Federation over long-lived JSON keys.

3. **Lifecycle/retention**
   - Configure bucket lifecycle rules to delete CUJ artifacts after **7 days**.

### Discoverability contract

Each run should publish:

- one commit status check context (`app-tests`) on the tested SHA,
- a status `target_url` set to the GCS run index:
  `https://storage.googleapis.com/<bucket>/cuj-runs/<repo>/<run>/<attempt>/index.html`.

This keeps the main PR Checks UI as the primary discovery surface while
avoiding repeated PR-comment noise.

Optional: one stable PR comment can still be updated in place when human-facing
summary text is needed, but this is not required for artifact discovery.

## Adding a new CUJ

1. Add a scenario doc in `docs-dev/cujs/<name>.md`.
2. Implement or extend a browser script under `app/test/browser/`.
3. Register the script in `app/test/browser/run-cuj-scenarios.ts`.
4. Ensure assertions are machine-verifiable.
5. Update docs if command names/flows changed.
