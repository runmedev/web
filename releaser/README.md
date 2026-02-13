# releaser

Build/publish helper for a combined `runmedev/runme` image that includes web static assets from `runmedev/web`.

## Invocation

```bash
go run . --runme=<branch> --web=<branch>
```

The tool:

1. Resolves latest commit SHA for each branch via GitHub API.
2. Checks whether `ghcr.io/runmedev/runme:runme-<runmeSHA>-web-<webSHA>` exists.
3. Exits if the image exists.
4. If missing, creates `${TMPDIR}/runme-<runmeSHA>-web-<webSHA>`, clones both repos, builds web assets, copies assets into runme, and publishes a multi-arch image via `ko`.

## Auth

Supported environment variables:

- `GITHUB_TOKEN` (works in GitHub Actions and locally if token has package scopes)
- `GH_TOKEN`
- `GHCR_TOKEN`
- `CR_PAT`
- `GHCR_USERNAME`
- `GITHUB_ACTOR`
- `GITHUB_REPOSITORY_OWNER`

If a token is present, the tool generates a temporary Docker config for `ko` pushes.

## Useful overrides

- `--runme-assets-dir=<path>`: override destination path inside runme repo for copied web assets.
- `--runme-main-pkg=./cmd/runme`: override ko target package.
- `--web-build-cmds="...;...;..."`: override web build commands.
- `--tmpdir=<path>`: override temporary workspace base.
