# releaser

Build/publish helper for `web.runme.dev`.

The tool clones the web repo and the Codex repo, builds the Codex WASM harness,
syncs the generated assets into the web app, builds `app/dist`, writes
`version.yaml`, and publishes the result to a bucket.

## Invocation

```bash
go run . --web=<branch>
```

Useful flags:

- `--codex=<branch>`: Codex branch to build for the WASM harness. Defaults to
  `dev/jlewi/wasm`.
- `--web-repo=<repo>`: web repo slug, URL, or local path. Defaults to
  `runmedev/web`.
- `--codex-repo=<repo>`: Codex repo slug, URL, or local path. Defaults to
  `openai/codex`.
- `--bucket=<dest>`: destination `gs://...` bucket or local directory. Defaults
  to `gs://runme-hosted`.
- `--dry-run=true`: build and report what would be published without uploading.
- `--tmpdir=<path>`: override the temporary workspace base.

## What it does

1. Resolves the requested web and Codex branch heads with `git ls-remote`.
2. Reads `<bucket>/version.yaml`.
3. Exits if the published version already matches the desired inputs, unless
   `--dry-run` is set.
4. Clones the web and Codex repos into a temporary workspace.
5. Builds the Codex WASM harness from `codex-rs/wasm-harness`.
6. Runs `pnpm run sync:codex-wasm` in `app/`.
7. Builds `app/dist`.
8. Publishes the built files and uploads `version.yaml` last.

## Requirements

- `git`
- `go`
- `pnpm`
- `rustup`
- `cargo`
- `wasm-bindgen`
- `gcloud` when publishing to `gs://...`

For local end-to-end testing you can point `--bucket` at a normal directory
instead of GCS.
