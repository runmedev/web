# Controlled app releases

Driver: `app/test/browser/run-controlled-releases.ts`; browser assertions:
`app/test/browser/controlled-releases.ts`. Run `pnpm -C app run cuj:releases`
after the workspace build. This production-bundle suite uses its own Go static
publication server and isolated browser context, independently of the dev-server
CUJs in `run-cuj-scenarios.ts`.

Acceptance:

- Deploy B while A is installed. Refresh and new tabs still use A.
- Pending notebook edits in multiple tabs persist before upgrade readiness.
- A failed preparation blocks activation and leaves that tab editable.
- Cancel before handoff: prepared tabs reopen their durable A state.
- Freeze a tab: it retains membership. A new tab waits outside the app.
- Close the initiating tab: another launcher resumes the persisted transition.
- All admitted tabs move to B under a new storage-owner epoch.
- Offline restart uses B; offline rollback to A preserves edits made on B.
- The recovery selector works independently of React/application imports.
- A checksum-valid but throwing app entry can be recovered through the selector
  after failed app tabs close, retaining current notebook content.

Artifacts include screenshots for each visible phase, one video per tab, build
logs and `result.json`. Inspect both assertions and screenshots: a rendered diagram
or a successful development-server reload does not establish these guarantees.
Unit tests separately cover checksum corruption/eviction, manifest rejection,
failed/uncertain flushes, owner RPC boundaries and existing corrupt-data recovery.
