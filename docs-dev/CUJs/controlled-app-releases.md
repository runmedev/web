# Controlled app releases

Driver: `app/test/browser/run-controlled-releases.ts`; browser assertions:
`app/test/browser/controlled-releases.ts`. Run `pnpm -C app run cuj:releases`
after the workspace build. This production-bundle suite uses its own Go static
publication server and isolated browser context, independently of the dev-server
CUJs in `run-cuj-scenarios.ts`.

Acceptance:

- An uncontrolled legacy window blocks initial admission until it closes.
- An already-controlled tab opens the installed app even if service-worker
  registration lookup and readiness never settle. The browser journey retains
  real cached assets, workers and tab admission, and saves a screenshot of the
  successfully opened app. Unit tests separately verify a bounded error when
  first installation never supplies a controller.
- Startup shows verified-file progress. Blocking every font request still allows
  the app to open and report incomplete offline readiness. Retrying after fonts
  become available completes the offline cache without activating another release.
  Repeated app-readiness notifications do not restart completed font caching.
- The floating launcher disappears after startup only when the loaded app
  explicitly registers its version controls. Older clients retain the fallback
  controls. With a current app, the left Information icon opens version controls
  inside the Version Information document.
- Startup diagnostics expose timestamped stage, duration, and waiting/failure
  events before the app starts. The trace is bounded, stays in memory, and does
  not include notebook data, credentials, or URL query parameters.
- Deploy B while A is installed. Refresh and new tabs still use A.
- Channel changes and exact pins only stage; activation requires Upgrade all tabs.
- Pending notebook edits in multiple tabs persist before upgrade readiness.
- A failed preparation blocks activation and leaves that tab editable.
- Cancel before handoff: prepared tabs reopen their durable A state.
- Freeze a tab and explicitly withhold its readiness acknowledgement: it retains membership. A new tab waits outside the app.
- Close the initiating tab: another launcher resumes the persisted transition.
- All admitted tabs move to B under a new storage-owner epoch.
- After full offline readiness, offline restart uses B; offline rollback to A preserves edits made on B.
- The recovery selector works independently of React/application imports.
- A checksum-valid but throwing app entry can be recovered through the selector
  after failed app tabs close, retaining current notebook content.

- A throwing owner entry blocks handoff; selecting the prior cached release
  recovers storage ownership and preserves current notebook contents.

Production also supplies its frozen candidate snapshot as B; it publishes those
exact tested files without rebuilding. The other builds are emitted fixtures
within the current storage compatibility contract, not historical schema tests.

Artifacts include screenshots for each visible phase, one video per tab, build
logs and `result.json`. Inspect both assertions and screenshots: a rendered diagram
or a successful development-server reload does not establish these guarantees.
Unit tests separately cover checksum corruption/eviction, manifest rejection,
failed/uncertain flushes, owner RPC boundaries and existing corrupt-data recovery.
