# Testing Architecture

This document describes how testing is organized in this repository, with a
specific focus on deterministic CUJ/scenario testing and artifact publication.

## Goals

1. Fast feedback for code changes.
2. Reliable, deterministic regression detection for core user workflows.
3. Durable, reviewable artifacts (images/videos/logs) for behavior validation.
4. Clear division of responsibility between test automation and Codex review.

## Test layers

### 1) Unit/component tests (fast, deterministic)

- Framework: Vitest.
- Scope: isolated functions and React components.
- Example location: `packages/react-console/src/components/__tests__/`.

These tests are expected to run on every PR and are the first quality gate.

### 2) Build validation

Build order follows package dependencies:

1. `renderers`
2. `react-console`
3. `app`

Build validation ensures each package compiles and bundles successfully.

### 3) CUJ/scenario browser tests (deterministic TypeScript programs)

- Location: `app/test/browser/`.
- Language/runtime: TypeScript + Node execution.
- Primary scenario orchestration entrypoint: `app/test/browser/run-cuj-scenarios.ts`.
- Driver entrypoint (env checks + publication): `app/test/browser/cuj-driver.ts`.

**Requirement:** CUJ/scenario tests must be implemented as deterministic
TypeScript programs that can run without AI intervention.

AI/Codex may trigger or review results, but the test logic itself should be
fully programmatic and reproducible.

## CUJ source of truth

CUJs are defined in markdown under `docs-dev/cujs/`.

Each CUJ file should include:

- preconditions,
- user journey steps,
- machine-verifiable acceptance criteria.

Current baseline CUJ:

- `docs-dev/cujs/hello-world-local-notebook.md`.

## CUJ runner contract

Every scenario test should:

1. Validate preconditions and fail fast with clear diagnostics.
2. Execute deterministic steps only (no subjective/manual-only assertions).
3. Emit structured pass/fail assertions.
4. Produce artifacts:
   - screenshots,
   - snapshots/logs,
   - short video where supported.
5. Write outputs to a known artifact directory.

## Driver architecture (local + GHA)

A dedicated TypeScript driver should orchestrate scenario execution and
publication concerns.

Driver responsibilities:

1. Environment setup checks
   - frontend/backend reachability,
   - required tools available,
   - auth/token presence for publication,
   - install `runme` into `${REPO_ROOT}/bin` via `go install github.com/runmedev/runme/v3@main`.
2. Scenario orchestration
   - run selected/all CUJ scenario scripts,
   - aggregate assertion summaries.
3. Artifact collection
   - normalize paths and metadata,
   - produce machine-readable summary output.
4. Publication
   - upload artifacts to a durable channel (for local Codex runs: release assets in the target repo),
   - mirror/copy artifacts under `.artifacts/cuj-runs/` for local inspection (gitignored),
   - comment results on PR/issue when credentials permit,
   - repo selection should be deterministic (env override, CI-provided repo, then git remote fallback).

The same driver design should run in both contexts:

- local developer execution,
- GitHub Actions execution.

Runtime-specific behavior (e.g. artifact upload implementation) should be
selected by configuration/environment, not by duplicating test logic.

## Publication model

Use durable artifact references for PR/issue reporting.

- Never treat local `/tmp/...` paths as final reviewer-facing links.
- Prefer GHA artifacts, committed artifact files, or other durable storage.
- Post links via `gh` (`gh issue comment` / `gh pr comment`) when token scope
  allows write access.
- For GitHub Release-based artifact hosting, token needs repository `Contents: write` permission.

## Codex role (reviewer, not test runtime)

Codex should primarily act as a reviewer of the deterministic test system:

1. Ensure CUJ docs are updated when features/bugs change workflows.
2. Ensure TypeScript CUJ tests stay in sync with CUJ markdown criteria.
3. Ensure artifact evidence supports the assertions the test claims to verify.
4. Flag mismatches between claimed coverage and observed assertions/artifacts.

Codex may run the driver and summarize outcomes, but CUJ correctness must not
depend on Codex-specific reasoning in the execution path.

## Adding or updating a CUJ

1. Add/update scenario doc in `docs-dev/cujs/<name>.md`.
2. Implement/update deterministic scenario test in `app/test/browser/`.
3. Register it in `app/test/browser/run-cuj-scenarios.ts`.
4. Ensure `app/test/browser/cuj-driver.ts` can execute it and publish summary artifacts.
5. Ensure required artifacts and assertion summary are produced.
6. Validate driver behavior locally and in GHA configuration.
7. Have Codex review CUJ↔test sync and artifact adequacy.


## Design constraints: PR/issue artifact attachments

Direct binary attachment upload to PR/issue comments is not reliably available via
standard `gh pr comment` / `gh issue comment` flows. Treat this as a design
constraint for the CUJ driver.

Implications:

- Driver comments should include durable links, not local paths.
- For local runs, keep artifacts under `.artifacts/cuj-runs/` (gitignored).
- For CI runs, prefer GitHub Actions artifact upload and link to the run/artifact
  page in the PR comment/check output.

## CI artifact publishing policy (GHA)

When running in GitHub Actions (`GITHUB_ACTIONS=true`), the driver or workflow
should:

1. Write all CUJ outputs to `.artifacts/cuj-runs/<run-id>/`.
2. Upload that directory using `actions/upload-artifact`.
3. Publish a machine-readable summary (JSON) and human summary (Markdown).
4. Link to the artifact bundle from PR comments and/or check summaries.

## Rich reporting options in GHA/status checks

GitHub Actions + checks can provide richer review UX even without direct comment
attachments:

1. **Step Summary (`$GITHUB_STEP_SUMMARY`)**
   - Markdown report in the workflow run page.
   - Include pass/fail table, assertion counts, and links to uploaded artifacts.

2. **Uploaded artifact bundle**
   - Bundle screenshots/videos/logs + `summary.json` in one downloadable artifact.
   - Include an `index.html` in the bundle for local viewing after download.

3. **Check run annotations + links**
   - Expose key failures as annotations.
   - Link to workflow run and artifact bundle from the check output.

4. **Optional Pages/report hosting**
   - For truly inline rich HTML, publish a static report site (e.g. GitHub Pages
     or other static hosting) and link it from PR/checks.
   - Artifact ZIPs themselves are downloadable, but not rendered as embedded
     rich pages directly inside PR comments.

