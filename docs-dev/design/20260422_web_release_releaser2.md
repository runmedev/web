# 20260422 web.runme.dev Releasing

## Status

Draft proposal.

## Summary

Replace the current OCI-oriented release flow with a level-based GCS publisher
for `web.runme.dev`.

The new releaser should:

- stop building and publishing a `runme` OCI image
- stop publishing the web app as a GHCR OCI artifact
- build the web static assets, including the Codex WASM bundle
- publish the site to `gs://runme-hosted`
- write a `version.yaml` marker after a successful publish
- skip the release when the bucket already contains the desired version

This matches the way the site is actually served today: static files from GCS,
not a container image.

## Problem

Today the repo has three different release stories:

1. `releaser/` builds `runmedev/runme` plus web assets and pushes a multi-arch
   image to GHCR.
2. `.github/workflows/publish-app-assets-oci.yaml` builds `app/dist` and pushes
   it to GHCR as a static-assets OCI artifact.
3. The manual production process for `web.runme.dev` builds the app locally and
   copies files directly into `gs://runme-hosted`.

The first two paths no longer match production. They create artifacts that are
not the deployment target. The third path is the real deployment path, but it
is manual and not level-based.

We want one release flow with these properties:

- it produces the exact assets that `web.runme.dev` serves
- it is safe to run repeatedly
- it can detect that production is already current
- it records what was published

## Goals

- Publish `web.runme.dev` directly to GCS.
- Keep the releaser idempotent.
- Record release metadata in a machine-readable `version.yaml`.
- Preserve the current build inputs, including the external Codex WASM build.
- Publish `version.yaml` last so it acts as the success marker for the release.

## Non-Goals

- Continue packaging the web app as an OCI image or OCI artifact.
- Embed web assets into the `runmedev/runme` repo before release.
- Redesign site hosting away from the existing GCS bucket.
- Solve rollback automation in this change.

## Current State

### Current manual publish flow

The current manual process is roughly:

1. Build the Codex WASM harness from `~/code/codex/codex-rs/wasm-harness`.
2. Run `pnpm -C app run sync:codex-wasm`.
3. Build the web app with `pnpm build:app`.
4. Copy a set of files into `gs://runme-hosted`.

The copied files are currently:

- `app/dist/index.html`
- hashed `index.*` assets
- `generated/codex-wasm/codex_wasm_harness.js`
- `generated/codex-wasm/codex_wasm_harness_bg.wasm`
- `configs/app-configs.yaml`
- `policies/*`
- `about.html`

After `sync:codex-wasm`, these files should all come from `app/dist`, so the
release source of truth should be the built `app/dist` tree.

### Current releaser mismatch

The existing `releaser/` binary does not model production correctly:

- it resolves both `runmedev/runme` and `runmedev/web`
- it checks GHCR for an image tag
- it copies built web assets into the `runme` repo
- it publishes a multi-arch image with `ko`

That logic is now orthogonal to how `web.runme.dev` is deployed.

## Proposal

### Keep one releaser, change its target

Keep the `releaser/` Go tool, but simplify its purpose to:

- resolve the desired source revisions
- build the web release payload
- compare the desired version against the currently published version
- publish static files to GCS when the bucket is stale

The releaser should no longer know about:

- `runmedev/runme`
- GHCR image existence checks
- Docker auth
- `ko`

### Proposed inputs

The releaser should be driven by the inputs that actually affect the deployed
site:

- `web repo + branch + commit`
- `codex repo + branch + commit` for the WASM harness, with the initial
  default branch set to `dev/jlewi/wasm`
- destination bucket, initially `gs://runme-hosted`

This is the critical change from the current image releaser. The build is not a
pure function of the web repo alone because the Codex WASM assets are built from
another checkout.

If we only compare `webCommit` with the bucket marker, the releaser will miss
cases where the WASM bundle changed but the web repo did not.

### Proposed workflow shape

1. Resolve the desired source commits.
   - `webCommit`
   - `codexCommit`
2. Read the current `version.yaml` from the bucket.
3. If the bucket metadata already matches the desired inputs, exit successfully.
4. Clone the source repos into a temporary workspace, including the Codex repo
   from `dev/jlewi/wasm`.
5. Build the release payload in that workspace.
6. Upload the site files to GCS.
7. Upload `version.yaml` last.

The workflow remains safe to run on a schedule, on `main`, or by
`workflow_dispatch`.

## Release Inputs And Build Steps

### Source checkouts

The releaser should check out:

- `runmedev/web`
- the Codex repo that provides `codex-rs/wasm-harness`

The releaser must not assume the Codex repo already exists on disk. It should
clone the Codex repo itself as part of the release job and check out
`dev/jlewi/wasm` by default.

This replaces the current local-user-specific assumption of `~/code/codex/...`.

### Build sequence

The release job should include the normal workspace prerequisites and then the
manual Codex WASM steps:

1. Install dependencies.
2. Build shared workspace packages needed by the app.
3. Build the WASM harness.
4. Run `pnpm -C app run sync:codex-wasm`.
5. Run the normal web build.

Concretely, the releaser should run the equivalent of:

```sh
git clone --branch main <web-repo-url> <web-repo>
git clone --branch dev/jlewi/wasm <codex-repo-url> <codex-repo>

cd <web-repo>
pnpm install --frozen-lockfile
pnpm run build:renderers

cd <codex-repo>/codex-rs/wasm-harness
./scripts/build-browser-demo.sh

cd <web-repo>/app
pnpm run sync:codex-wasm

cd <web-repo>
pnpm build:app
```

The releaser should treat `app/dist` as the publish root.

## Publishing Model

### Publish from `app/dist`

The releaser should publish the built `app/dist` contents to the bucket instead
of maintaining a hard-coded list of hand-copied files. This makes the release
flow match the actual build output and avoids drift between the build and the
publisher.

The publisher can still apply path-specific metadata rules.

### Cache-control policy

We should publish different classes of files with different cache policy:

- `index.html`: `Cache-Control: no-cache, max-age=0, must-revalidate`
- `version.yaml`: `Cache-Control: no-cache, max-age=0, must-revalidate`
- stable-path mutable files such as `generated/codex-wasm/*`,
  `configs/app-configs.yaml`, `about.html`, and `policies/*`:
  `Cache-Control: no-cache, max-age=0, must-revalidate`
- content-addressed hashed assets such as `index.<hash>.js` and
  `index.<hash>.css`: long-lived immutable caching

This is stricter than the current manual flow and prevents us from disabling
cache on files whose names already carry content identity.

### Upload ordering

The releaser should upload in this order:

1. hashed/static payload files
2. mutable stable-path files
3. `index.html`
4. `version.yaml`

`version.yaml` must be last. Its presence means the rest of the payload for that
version is already in place.

## `version.yaml`

### Purpose

`version.yaml` is the release marker that lets the publisher behave like a
level-based controller.

The releaser compares desired state to this file. If they match, it does
nothing.

### Proposed schema

```yaml
buildDate: "2026-04-22T14:05:33-07:00"
webRepo: "runmedev/web"
webBranch: "main"
webCommit: "<git-sha>"
codexRepo: "<codex-org>/<codex-repo>"
codexBranch: "dev/jlewi/wasm"
codexCommit: "<git-sha>"
bucket: "gs://runme-hosted"
```

`buildDate` is informational only. The level comparison should ignore it and
compare the source identity fields.

### Comparison rule

The releaser should treat the bucket as up to date when all of the following
match the desired inputs:

- `webRepo`
- `webBranch`
- `webCommit`
- `codexRepo`
- `codexBranch`
- `codexCommit`
- `bucket`

That gives us deterministic idempotency even when the release job runs hourly.

## Workflow Changes

### GitHub Actions

`.github/workflows/releaser.yaml` should become the single automated release
entrypoint for `web.runme.dev`.

It should:

- authenticate to GCS instead of GHCR
- build the releaser binary
- run the releaser in publish mode on `main` and schedule
- run it in dry-run mode for pull requests

We should remove:

- GHCR login
- `ko` installation
- image push permissions

### Remove obsolete OCI publishing

Once the GCS releaser is live, we should retire:

- the GHCR/image path in `releaser/`
- `.github/workflows/publish-app-assets-oci.yaml`

Those artifacts do not represent production anymore and will cause confusion if
they remain.

## Failure Model

- If the build fails, nothing is published.
- If file upload fails before `version.yaml`, the next run will retry because
  the version marker still points at the previous release.
- If `version.yaml` upload succeeds, the release is considered complete.

This is the main reason to treat `version.yaml` as the final commit point.

## Open Questions

1. Which Codex repository URL should automation use with the fixed branch
   `dev/jlewi/wasm`?
2. Should the publisher use `gcloud storage` or `gsutil` for uploads in CI?
3. Do we want the releaser to delete old hashed assets from the bucket, or is
   additive publishing acceptable for now?

## Recommended Implementation Order

1. Refactor `releaser/` to remove `runme` and OCI concepts.
2. Add GCS publishing plus `version.yaml` read/compare/write.
3. Update `.github/workflows/releaser.yaml` to authenticate to GCS and invoke
   the new releaser.
4. Remove the separate OCI asset publishing workflow.
