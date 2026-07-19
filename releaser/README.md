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
