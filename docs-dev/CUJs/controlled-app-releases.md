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
- A stalled release-settings open times out and automatically tries latest stable
  through verified downloads and normal admission. Persistent settings failures
  expose retry, channel and exact-release controls without accessing IndexedDB.
  Retrying after the browser recovers opens the app without resetting stored state.
  Unit tests cover missing records, blocked/failed/late opens, read failures,
  stalled commits, abort cleanup, and preserving existing epochs/transitions.
- An irrecoverable settings value (`NotReadableError`) is quarantined only when
  no storage owner or other tab remains. The old object store is preserved, a
  version bump fences older readers, and the recovered state uses bounded chunks.
  The browser test verifies an existing notebook and a mounted Explorer folder
  survive repair and reload. The folder is persisted in the separate notebook
  database and localStorage before injecting the release-control failure.
  Unit tests reject repair for live owners/tabs and transient errors.
- Unreadable workspace preferences remain untouched, including when Explorer
  adds its default root. Show a persistence warning until a successful reload.
  Missing folder metadata hides only that unresolved root; it must not remove
  the saved mount. Unit tests cover both cases and healthy legacy migration.
- Deploy B while A is installed. Refresh and new tabs still use app/owner A,
  while the bootstrap selects launcher B. An existing A tab stays open during
  this assertion, and the screenshot must show the rendered app, not merely
  initialized automation APIs or a router error page.
- For a pre-bootstrap installation, enter through B's immutable
  `/version/<release-id>/launcher.html`. This entry must normalize its route and
  open the selected older app without forcing the existing tabs to reload.
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
exact tested files without rebuilding. CI runs both current-source fixtures and
the frozen pre-bootstrap commit `9a5fdbf0ca30bf73431b7c4eb90f75f3c91e3ecf` as A,
built with its own lockfile. Set `RUNME_RELEASE_BASELINE_COMMIT` to reproduce that
compatibility run, or `RUNME_RELEASE_BASELINE` to use a previously built release.
Both runs use the current storage compatibility contract; they do not establish
compatibility with arbitrary historical notebook schemas.

Artifacts include screenshots for each visible phase, one video per tab, build
logs and `result.json`. Inspect both assertions and screenshots: a rendered diagram
or a successful development-server reload does not establish these guarantees.
Unit tests separately cover checksum corruption/eviction, manifest rejection,
failed/uncertain flushes, owner RPC boundaries and existing corrupt-data recovery.
Launcher selection tests cover bounded network/cache waits, incompatible
descriptors, offline fallback, corrupted modules, interrupted publication, and
reuse of verified modules on refresh. Releaser tests verify that the launcher
advances even when the stable application channel is pinned.
