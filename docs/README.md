# Runme Web User Docs

These documents describe supported Runme Web behavior and setup.

Use this set for:

- product behavior,
- UI layout,
- setup and configuration flows,
- App Console commands,
- runner selection,
- troubleshooting.

Current numbered docs:

- [00-getting-started.md](00-getting-started.md)
- [01-editing-and-running-cells.md](01-editing-and-running-cells.md)
- [02-workspace-explorer.md](02-workspace-explorer.md)
- [03-local-notebooks-and-browser-storage.md](03-local-notebooks-and-browser-storage.md)
- [04-filesystem-workspaces.md](04-filesystem-workspaces.md)
- [05-google-drive-integration.md](05-google-drive-integration.md)
- [06-sharing-and-opening-drive-links.md](06-sharing-and-opening-drive-links.md)
- [07-runners-overview.md](07-runners-overview.md)
- [08-local-runme-runners.md](08-local-runme-runners.md)
- [09-appkernel-browser-runners.md](09-appkernel-browser-runners.md)
- [10-jupyter-runners.md](10-jupyter-runners.md)
- [11-webmcp-external-control.md](11-webmcp-external-control.md)
- [13-app-console-reference.md](13-app-console-reference.md)
- [14-authentication-and-app-configuration.md](14-authentication-and-app-configuration.md)
- [15-logs-diagnostics-and-troubleshooting.md](15-logs-diagnostics-and-troubleshooting.md)
- [16-notebook-diffs.md](16-notebook-diffs.md)
- [17-ipynb-notebooks.md](17-ipynb-notebooks.md)
- [18-progressive-web-app.md](18-progressive-web-app.md)

These docs intentionally exclude implementation-only material such as deployment
internals and design proposals. Internal notes remain under `docs-dev/` and
`docs/design/`.

## Adding or updating documentation

Every published guide owns its discovery metadata in YAML frontmatter:

```yaml
---
name: stable-kebab-case-name
title: Human-readable title
order: 0
description: >-
  Explain when an AI agent should choose this document, the tasks or questions
  it covers, and how it differs from nearby guides. Descriptions may use
  multiple sentences when that improves document selection.
---
```

Regenerate the metadata-only application manifest after changing frontmatter:

```sh
pnpm generate:documentation
```

`pnpm check:documentation` fails when the checked-in manifest is stale or the
frontmatter is missing, invalid, disagrees with the document's level-one
heading, or contains duplicate names or order values. Document bodies remain in
this directory and are fetched from commit-pinned GitHub URLs; only discovery
metadata is included in the application build.
