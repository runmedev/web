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
  inside the Version Information document. A badge and descriptive tooltip on the
  Information icon signal a downloaded update, an outdated tab, or a version
  problem. Apps supporting this affordance keep the overlay hidden during
  updates and handoffs; actions and status remain in Version Information.
- Startup diagnostics expose timestamped stage, duration, and waiting/failure
  events before the app starts. The trace is bounded, stays in memory, and does
  not include notebook data, credentials, or URL query parameters.
- A stalled release-settings open shows independent recovery controls without
  changing selection or activating stable automatically. Explicit retry opens
  the installed release. A later admission `get` timeout records failed startup
  and exposes the same controls; retry retains the installed release.
- Normal startup neither scans peer tab locks nor resumes pending upgrades.
  Release-change hints update badges without a periodic tab reconciliation loop.
  Only explicit activation/retry starts a pending worker (except first install).
  Abandoned activation remains visible for an explicit retry.
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
- Hold a new tab's launcher discovery pending and probe it from another tab
  through the real service worker. It must answer before importing the launcher,
  then open the selected app when discovery resumes. Slow discovery must never
  misclassify a controlled bootstrap as an incompatible legacy window.
- Channel changes and exact pins only stage; activation requires an explicit action.
- Activating B replaces the worker under its lifetime lock and reloads only the initiating tab.
- A frozen peer with a failing preparation hook cannot block activation and is never asked to prepare.
- The old peer keeps its tab identity and mounted editor, then saves through worker B on retry.
- Reloading another tab is an independent action. A session-storage quota error leaves that tab editable and does not roll back the selected worker.
- A successful local reload checkpoints and restores editor state without involving a peer.
- A confirmed capability mismatch triggers local checkpoint/reload recovery before any data RPC. Timeouts alone never do.
- Historical rollback requires a durable flush of the initiating tab. Current peers refuse checkpoint reload into an app without `tabRecoveryFormat: 1`, retaining their mounted editors.
- Historical launchers retain their original behavior. The frozen-baseline migration closes durable legacy peers before activation; the initiating historical app flushes locally before worker replacement.
- After full offline readiness, offline restart uses B; offline rollback to A preserves edits made on B and leaves other tabs on their loaded UI versions.
- The current recovery selector works independently of React/application imports, explains
  that notebooks open in the app, and keeps **Return to Runme** visible. Returning
  opens the app in the same tab with its session and hash preserved.
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

## Recovery while the app is already open

- Inject a rejected or never-settling `runmeVersions.get()` after opening Version
  Information. The **Pin Release** button must remain available and open a
  separate workspace tab. Users choose the installed release or select another
  build by browsing or entering a commit. Reviewing a selection has no side
  effects; pinning and activation are separate actions. Recovery navigation and
  memory-only diagnostics remain reachable under **Troubleshooting**, even
  while settings or a download are stalled. Also cover an
  older launcher without the new recovery API: the selected release is carried
  to the independent recovery page without navigating the editor tab away.
- Preparing a build downloads and verifies it without accessing release settings.
  It must not activate the build. Explicit activation still uses the existing
  tab preparation, compatibility checks and exclusive storage-owner handoff.
- A commit prefix with several published builds must require selecting a full
  release ID rather than guessing a build. An unpublished commit is not runnable.
- Diagnostic traces distinguish missing initial get callbacks, incomplete chunk
  reads and pending transaction completion. Include elapsed time, realm and mode;
  exclude record values, notebook contents, credentials and arbitrary keys.
- These failure-injection checks are automated in `ReleaseRecoveryControls.test.tsx`,
  `releaseCatalog.test.ts`, `releaseDatabase.test.ts` and `startupRecovery.test.ts`.

## Unresponsive storage owner

- The recovery banner's **Check storage worker** action works while restart or
  normal RPC admission is waiting. A diagnostic reply must not replay a mutation.
- Report authorization before initialization, initialization, authorization after
  initialization, and execution separately. Restart diagnostics identify release
  settings, waiting for tab backups, waiting for active requests and draining.
- Keep diagnostic snapshots bounded and memory-only, including release database
  traces from the worker realm. A diagnostic reply proves message-loop liveness,
  not persistence health; absence of a reply does not prove the worker is dead.
- Never steal the ownership lock or launch a competing writer after a timeout.
  Explain that users must download current editor copies in every tab before
  closing tabs or restarting the browser; session copies alone are insufficient.
- Automated coverage: `storageOwner.test.ts`, `storageRecovery.test.ts`, and
  `StorageRecoveryBanner.test.tsx`. Existing browser restart and upgrade journeys
  remain in `storage-owner-recovery.ts` and `controlled-releases.ts`.
