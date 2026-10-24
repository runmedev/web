# releaser

Build/publish helper for `web.runme.dev`.

The tool clones the web repo, builds `app/dist`, writes `version.yaml`, and
publishes the result to a bucket.

## Invocation

```bash
go run . --web=<branch>
```

Useful flags:

- `--web-repo=<repo>`: web repo slug, URL, or local path. Defaults to
  `runmedev/web`.
- `--bucket=<dest>`: destination `gs://...` bucket or local directory. Defaults
  to `gs://runme-hosted`.
- `--dry-run=true`: build and report what would be published without uploading.
- `--tmpdir=<path>`: override the temporary workspace base.

## What it does

1. Resolves the requested web branch head with `git ls-remote`.
2. Reads `<bucket>/version.yaml`.
3. Exits if the published version already matches the desired inputs, unless
   `--dry-run` is set.
4. Clones the web repo into a temporary workspace.
5. Builds `app/dist`.
6. Publishes the built files and uploads `version.yaml` last.

## Requirements

- `git`
- `go`
- `pnpm`
- `gcloud` when publishing to `gs://...`

For local end-to-end testing you can point `--bucket` at a normal directory
instead of GCS.

## Declarative immutable builds (release management foundation)

The opt-in reconciler computes the desired release ID **before building**:

```bash
go build -trimpath -o /tmp/runme-releaser .
/tmp/runme-releaser reconcile --web=main --bucket=/tmp/runme-releases
```

`RELEASE_ID = <full web commit SHA>-<BUILD_ID>`. `BUILD_ID` is the full SHA-256
of compact JSON for the versioned `buildInputs` structure in `reconcile.go`.
Field order is fixed and public configuration map keys are sorted by the JSON
encoder. Inputs include the resolved source repository/commit, the releaser
binary checksum, exact Node/pnpm versions, OS/architecture, public `VITE_*`
configuration and `--build-revision` (default `1`). Branch and destination also
participate because the app currently embeds them in version metadata. The source
commit covers checked-in build scripts, configuration and dependency lockfiles.

The same binary and inputs produce the same ID across invocations. Keep the
builder artifact/toolchain pinned; rebuilding the releaser with different Go
tooling or embedded paths can change its checksum. Build with `-trimpath` to avoid
checkout-path differences. CI run numbers, wall-clock time and output hashes do
not participate. Embedded build date is the source commit time. Bump the declared
`--build-revision` to request another build with otherwise identical inputs.

The reconciler reads `version/<RELEASE_ID>/archive.json`, validates its inputs,
then verifies all listed files (and GCS serving metadata). A matching complete
archive is a no-op: no clone, install or build. An absent completion manifest
triggers a build and create-only publication, with the manifest last. Access
errors, malformed manifests, corrupt files and conflicting bytes fail without
overwriting existing objects. Interrupted publication can resume only if the
rebuilt bytes agree with already published files. `--dry-run` checks desired state
and reports the ID without building or writing. This differs from the legacy
root command's build-through dry run.

These are deterministic **identities**, not a claim that builds are hermetic.
The build environment excludes arbitrary ambient build switches, but host tools,
user package-manager configuration and dependency installation can still affect
outputs. Artifact checksums enforce immutability; a pinned builder environment
and real-build reproducibility checks remain rollout gates. `VITE_*` settings
are public browser configuration and appear in provenance; do not put credentials
there. Installation credentials are not included in the identity or manifest.

The reconciler archives builds without changing the root app or channels.
Activation manifests, version-relative asset builds and the loader are still
pending. The existing production publisher remains unchanged.

### Archive an existing build

Archive an already completed build without changing the root app or any channel:

```bash
go run . archive --dist=/path/to/completed/dist --bucket=/tmp/runme-archives
```

The build must include `index.html` and the publisher's `version.yaml` containing
the full lowercase `webCommit` SHA. Stop writing to the build directory before
archiving. The command snapshots its files before hashing and upload. It neither
builds the app nor changes the source directory. `--bucket` is required; this
subcommand has no production destination default. `--dry-run` reports the exact
inventory and destination without writing destination objects.

The same command supports an explicit `gs://bucket/prefix` destination. It uses
GCS generation-zero preconditions, immutable cache headers, and generation-specific
readback to check persisted SHA-256 and byte length. A retry succeeds only when
the persisted bytes and required metadata match. Local publication uses an
exclusive hard link to a completed temporary file, then verifies the result.
Conflicts fail without replacing the existing object.

```text
<destination>/version/<webCommit>-<artifactDigest>/
  index.html
  storage-owner.js
  ...all other build files...
  version.yaml
  archive.json       # written and verified after every asset
```

`artifactDigest` is the full SHA-256 of the compact JSON encoding of the asset
array in `archive.json`, sorted by path. Each entry contains `path`, `sha256` and
`bytes`, in that field order. The archive manifest is excluded from that array.
For this standalone `archive` command, different build bytes at the same source
commit receive different IDs; identical snapshots produce identical manifests.
It cannot check desired state before a build. Use `reconcile` for declarative
pre-build identity; its manifest separately records `buildId`, `buildInputs` and
the output `artifactDigest`. Publication can resume after interruption.
A completed manifest is never written when an asset fails validation.

**An archive is not yet a selectable application release.** It preserves the
build's URLs unchanged, so today's root-relative builds are not runnable solely
from their version directory. `archive.json` has kind `runme-build-archive` and
does not replace the proposed `release.json` compatibility contract. This command
does not create a catalog, promote stable/latest, register a worker, or enable
rollback. The normal publisher and deployment workflow continue using their
existing path; archiving is opt-in.

The next implementation steps are to separate route/asset bases, build the
release-control database and loader, deploy the compatible owner bridge, and
validate coordinated activation before offering archived versions to users.
See the [design and rollout tracker](https://web.runme.dev/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1Y_8MJZW9SDFI32ubwneVBz7OzffkIYL1%2Fview).

### Validation

```bash
go test -race ./...
```

Tests cover deterministic pre-build IDs, no-op reconciliation, explicit rebuild
revisions, corruption/access errors without rebuild, changed bytes at one commit, concurrent identical
publication, conflicting retries, partial uploads, invalid paths/builds, dry runs
and preserving root/channel objects. A Go fake of the gcloud command boundary
checks create-only arguments, generation-qualified reads and metadata failures.
These tests do not substitute for a real staging-bucket/CDN check before rollout.

GCS command contracts: [storage cp](https://cloud.google.com/sdk/gcloud/reference/storage/cp)
and [objects describe](https://cloud.google.com/sdk/gcloud/reference/storage/objects/describe).
