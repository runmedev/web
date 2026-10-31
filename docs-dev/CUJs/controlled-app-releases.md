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
- Opening tabs, worker startup, editor readiness, background discovery, worker
  errors, and cache cleanup perform no release-settings writes. The browser
  journey forbids release `readwrite` transactions while rendering the app and
  creating a real notebook. A global cache-maintenance lock cannot block startup.
- A stalled or irrecoverable release-settings read uses the independent saved
  selection in Cache Storage. It does not quarantine/repair settings, reload
  peers, or select an arbitrary downloaded candidate. A damaged-settings journey
  verifies that saved notebook content and a mounted Explorer folder survive
  fallback and reload. Historical baselines retain their historical repair test.
- A real write transaction held open on the release-settings store cannot block
  starting a replacement storage worker or authorizing its notebook RPCs. The
  browser test keeps the transaction open until both operations succeed.
- Download candidates, handoff progress, readiness and errors are memory-only.
  An abandoned launcher cannot leave a persisted handoff blocking later tabs.
  Explicit activations serialize under a Web Lock, drain the previous owner, and
  save the installed release only after the replacement reports ready. No
  timeout permits stealing the storage ownership lock.
- Unreadable workspace preferences remain untouched, including when Explorer
  adds its default root. Show a persistence warning until a successful reload.
  Missing folder metadata hides only that unresolved root; it must not remove
  the saved mount. Unit tests cover both cases and healthy legacy migration.
- Deploy B while a registration-free A is installed. Refresh and new tabs still use app/owner A,
  while the bootstrap selects launcher B. An existing A tab stays open during
  this assertion, and the screenshot must show the rendered app, not merely
  initialized automation APIs or a router error page.
- For a pre-bootstrap installation, enter through B's immutable
  `/version/<release-id>/launcher.html`. If the historical worker requires tab
  registration, this entry shows explicit upgrade controls without a settings
  write or app import. Activation requires older tabs to save and close, and
  the migrated app must reopen the saved notebook with its content intact;
  unsupported rollback is rejected before changing selection. The migrated
  release must then reopen offline. Before the compact preferences are committed,
  migration activates a navigation loader that serves the latest-launcher
  bootstrap; a waiting loader must refuse activation if an unknown window fails
  its compatibility probe. Pre-migration channel changes retain the historical
  IDB record so older workers can continue saving until their tabs close.
- Hold a new tab's launcher discovery pending and probe it from another tab
  through the real service worker. It must answer before importing the launcher,
  then open the selected app when discovery resumes. Slow discovery must never
  misclassify a controlled bootstrap as an incompatible legacy window.
- Channel changes and exact pins only stage; activation requires an explicit action.
- A background channel check replaces an obsolete candidate when the channel points
  back to the installed release; no background candidate checks write settings.
- Activating B replaces the worker under its lifetime lock and reloads only the initiating tab.
- A frozen peer with a failing preparation hook cannot block activation and is never asked to prepare.
- The old peer keeps its tab identity and mounted editor, then saves through worker B on retry.
- Reloading another tab is an independent action. A session-storage quota error leaves that tab editable and does not roll back the selected worker.
- A successful local reload checkpoints and restores editor state without involving a peer.
- A confirmed capability mismatch triggers local checkpoint/reload recovery before any data RPC. Timeouts alone never do.
- Rollback requires `storageControlFormat: 1` and `tabAdmissionFormat: 1`; historical owners that require registration are rejected. Current peers also refuse checkpoint reload into an app without `tabRecoveryFormat: 1`, retaining their mounted editors.
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

- Cache cleanup honors shared lifetime asset leases held by current tabs and
  legacy tab records held by historical tabs. It must retain a release until its
  last lease closes; closing the last lease allows cleanup without a tab-record
  write. Only explicit preference/installed-release changes persist release settings; maintenance does not.

### Cached inventory fallback without readable preferences

When the release-settings read fails and there is no usable cached preference
copy, enumerate completed release inventories from Cache Storage and try the
most recent `publishedAt` first, independent of channel. Verify compatibility
and required cached bytes before activation; an unusable candidate must not hide
an older usable release. This path does not require network discovery or another
IndexedDB read. Existing owner draining, lifetime locks and historical-tab guards
still apply.

`cached-release-recovery.ts` exercises an offline startup with cached code but no
saved preferences and a permanently stalled release-settings open. It then
removes inventory markers in its disposable test profile, clicks “Try latest
channel,” and verifies the application opens without another settings attempt.
It also checks that an offline download failure on the standalone recovery page
does not retry IndexedDB while displaying the recovery error.
Screenshots and `cached-fallback-result.json` are published with release evidence.

### ExecuteCode with unavailable optional storage

`execute-code-storage-recovery.ts` runs against the emitted app and workers served
by the Go release fixture. It verifies normal persisted execution, keyed retries, and reload preparation
that drains pending console recording; seeds a saved console draft, then reloads while faulting opens of
`runme-app-console` and `runme-code-operations`. The public WebMCP handler must
return an operation ID, success, and `health-check` output before the browser
transport deadline. Opening App Console must show the output and a memory-only
history warning instead of an indefinite loading message. Reading the original
store must prove the saved draft is unchanged. The screenshot and JSON result
are uploaded with the controlled-release artifacts.
