# Storage lifecycle and recovery

## Decision

Tabs upgrade independently. Activating a published release replaces the shared
storage worker without waiting for any tab's readiness or acknowledgement. The
initiating tab then preserves its own state and reloads. Other tabs remain mounted
and editable, with an explicit control to update that tab when the user is ready.
A frozen or disconnected peer cannot block worker activation.

The selected worker and each tab's loaded application have separate identities.
Every reconnect resolves the selected worker, then negotiates a stable handshake
before sending data RPCs. Compatible old tabs keep working. An incompatible tab
attempts local checkpoint recovery once for that selected worker epoch; if preservation fails it keeps its editors and offers a retry; a timeout alone never proves a
version mismatch or authorizes automatic reload.

Local recovery freezes only that tab's edits and disconnects its transport. It
records a versioned session-storage checkpoint containing each editor's current
contents, observed operation history, acknowledged baseline, actor ID, and exact
pending operations. It verifies the written checkpoint before reloading. The new
app restores the captured editor, retries identical operation IDs, then persists
later edits relative to the captured baseline. It removes a checkpoint only after
those saves are acknowledged. Quota, malformed data, unsupported formats, active
executions, and uncertain non-editor operations keep the tab open. Checkpoints
survive reload, not closing the tab; recovery downloads remain available.

The worker's lifetime Web Lock remains the exclusive storage ownership authority.
The old owner stops admission and drains admitted work before releasing the lock.
Force-close is separately available through its management channel, provided the
worker event loop responds. It never asks tabs to reload. Generic mutations are
never replayed just because transport failed.

The launcher retains its independent update path and settings-failure recovery.
Release discovery and download remain independent of notebook storage. Startup
phase, queued settings reads, elapsed time, and RPC diagnostics are observable
without issuing another database read. No new tab-readiness coordinator is added.

### Compatibility boundary

The independent lifecycle applies to tabs running this launcher and recovery
contract. Already-running historical launcher code can still execute its old
reload policy; code in another tab cannot rewrite it. Old data-RPC versions are
rejected before effects, and unknown checkpoint formats are retained for recovery.
Legacy JSON/Markdown editors without replayable operation IDs require a durable local flush; if storage cannot acknowledge it, that tab stays open for export/retry.
Published manifests advertise `tabRecoveryFormat: 1`. Activation of a historical
release without that contract first durably flushes the initiating tab to its
current worker. Other current tabs refuse checkpoint-based reload into that
historical app; their editors remain open for export or selection of a supported
release. Compatibility of the notebook schema alone does not imply compatibility
of the recovery envelope.
Data-schema compatibility remains an activation prerequisite; independent tab
upgrades do not authorize concurrent incompatible storage formats.

## Failure analysis

Recent releases added editor snapshots and diagnostics (#417), immutable app
releases and multi-tab handoff (#418), version UI and partial offline readiness
(#419), loading diagnostics/UI handoff (#421), bounded release-settings access
(#423), unreadable-record quarantine (#425), and an independently updated launcher
(#428). #430 fixed the publication runner. These changes each address a real
failure, but recovery became dependent on the release database it was recovering.

The previous restart handler writes `emergencyRestart` before requesting editor
snapshots. If the release database stalls, no other tab is asked to preserve its
editors. This is a shared failure dependency, not proof of an IndexedDB lock cycle.
The editor preparation routine also awaits persistence through the failing worker.
That defeats the purpose of its independent session-storage snapshot.

A second bug treats MessagePorts as tabs. The launcher holds one control port and
the notebook app holds another editor port to the same worker. The launcher cannot
acknowledge editor preparation. Counting its control port as a participant can
block every restart. Diagnostics must report connections and editor clients
separately. A control connection is not evidence of unsaved editors.

## Invariants

- Only the worker holding `runme-storage-owner-lifetime-v1` opens notebook stores.
- Worker activation has no tab-readiness barrier and no peer reload command.
- A tab reloads for its own action, its own activation, or locally confirmed RPC incompatibility. Timeouts never trigger automatic reload.
- A reload checkpoint is verified before the page discards JavaScript memory.
- Save retries retain operation IDs and content; lost replies cannot duplicate edits.
- A restored baseline is the tab's captured baseline, not latest merged storage.
- RPC compatibility is checked before notebook or external effects.
- App and worker identities are independent; request fencing uses the selected worker epoch.
- Session-storage failure keeps the tab and its unsaved edits alive.
- Unknown mutation outcomes and unsupported recovery formats are never silently discarded.

## Browser boundary

Web pages cannot enumerate all browser SharedWorkers or externally terminate them.
Runme can list workers that implement its own discovery protocol, and request a
cooperative stop or force-close from those workers. A nonresponse is unknown status,
not proof of death. Browser DevTools can enumerate and terminate workers with
privileges unavailable to the page. The UI must state this limitation explicitly.

A dedicated storage worker with a supervisor could support external termination,
but introduces supervisor election, port forwarding and a second lifecycle. Chrome
also differs from the current HTML specification on Worker construction inside a
SharedWorker. Do not add this architecture as an untested recovery patch.

## Verification required

Real-browser tests must cover launcher plus editor ports, multiple editor tabs,
pending release-settings reads, pending persistence, new clients during recovery,
failed snapshots, worker initialization failure, and replacement identity under
the lifetime lock. Verify OPFS notebook contents after restart, and recovery copies
when an edit had not committed. Existing upgrade/offline/rollback journeys must
still pass. Unit tests alone do not establish lifecycle correctness.

## Registration-free tab startup

Normal startup reads the installed release from IndexedDB, verifies its cached
assets, and rechecks selection using a readonly transaction. Tabs no longer write
registration, loaded version, session label, or repeated readiness/healthy records.
The worker accepts unregistered tab IDs while retaining the active release/epoch,
handoff, and legacy prepared-participant fences before effects. An activation
racing the startup snapshot is rejected by the worker rather than authorized by a
persistent admission record.

A shared lifetime Web Lock named for the app release protects lazy-loaded assets.
Startup acquires it before verification without waiting on global downloads or
cleanup; cleanup probes its exclusive counterpart without waiting. Failed verification or
selection rechecks release the lease; document destruction releases retained leases. Existing
legacy tab records remain roots for cleanup until those tabs close. Old launchers
that do not understand asset leases cannot provide this new cleanup guarantee.

Manifests advertise `tabAdmissionFormat: 1` for registration-free owners. A new
launcher with an older selected worker exposes an explicit upgrade before loading
the app; it never synthesizes a tab record to make the old worker accept requests.
Rollback to an owner lacking this contract is rejected before changing release
state. One-time migration requires saving edits and closing older tabs: immutable
historical launchers can reload on an epoch change before their debounced saves
finish. The guard checks liveness locks and serializes against new historical
registrations before handoff. It also applies when retrying a pending activation.
Registration-free releases continue to upgrade without waiting for peer tabs.

Explicit selection, activation, recovery, owner startup and cache maintenance still persist
shared release state. Background discovery writes a genuinely new candidate, but
does not rewrite the installed/already-downloaded candidate on every page load.
Release selection reads remain a startup dependency: this change removes write
contention and registration failures, not all possible IndexedDB read failures.


## Small preferences and independent worker admission (2026-10-30)

The launcher reads a compact format-2 preference record containing a revision,
channel/pin selection, and current/previous release ID and generation references.
It resolves manifests from completed immutable Cache Storage inventories. It
reads historical format-1 records without rewriting them on page load. Only an
explicit selection change or completed activation writes preferences. Background
candidates, tab registration, readiness, startup errors, handoff progress and
cancellation are not persisted. Cache cleanup no longer prunes tab records.

A separate small Cache Storage copy preserves the last explicit selection. The
copy is written first under the preference-write Web Lock, with a monotonically
increasing revision. If an IDB write fails or commits late, a newer cached revision
wins. On a failed settings read, the launcher uses this copy and stops repeatedly
probing the failing database for the remainder of the page session. A subsequent
successful explicit settings write restores normal reads. A missing previous
cache cannot block opening the current release. No notebook data is repaired or
removed by this fallback. Without a usable saved copy, independent recovery
controls remain available; the launcher does not guess that the newest cache is
the user's intended selection.

Storage ownership is independent of preferences. Explicit activation writes a
small Cache Storage storage-target reference, asks responding workers to drain
through their memory-only management channel, and waits for the actual lifetime
ownership lock to become free. A worker validates its target before constructing
stores and after initialization, then reports readiness through its MessagePort.
It never opens the release-settings database. RPC authorization checks the
connected worker generation and tab identity in memory; host admission closes
before draining. The exclusive lifetime lock still prevents concurrent notebook
owners. Stale worker names fail before constructing stores. A stop failure or
unresponsive owner retains ownership; no timeout steals its lock.

The storage-target reference is an explicit activation intent, separate from the
last successfully installed app. If the initiating tab disappears, the previous
app can still open; compatible tabs can connect to the selected storage worker.
A failed target can be replaced explicitly with another cached compatible build.
Selecting app code does not erase or rewrite notebook stores. Surviving tabs keep
their editors and reconnect lazily; only the initiating tab checkpoints/reloads.

The manifest advertises `storageControlFormat: 1`. Historical workers cannot be
made independent of preferences by changing only their launcher. Their tabs must
save and close for the one-time migration; releases lacking this contract are not
rollback targets. Current releases keep independent tabs and replayable saves.

Validation includes preference projection/no-op tests, cached fallback after
failed reads and uncertain writes, real worker startup and RPC while a release
settings writer is held open, multi-tab activation/rollback with preserved edits,
and frozen historical migration. The launcher reports the preference source in
startup diagnostics; worker lifecycle/errors remain in memory and logs.


Before the first compact installed-release record is written, the launcher
ensures that the controlling navigation worker serves the latest-launcher
bootstrap. An immutable historical worker can otherwise serve its old launcher
on an offline refresh, which cannot parse format 2. Migration explicitly asks a
waiting loader to activate; that worker independently verifies every live window's
loader contract before `skipWaiting` and does not reload any editor. Ordinary
refreshes still use their existing controller immediately. Channel/pin changes
while an older release is installed stay in the cached preference copy until
migration completes, leaving the old worker's format-1 record readable.

Historical format-1 records are projected into saved selection, active and previous releases on read. Old tab registrations, handoffs, candidates and worker errors are ignored by the new launcher, without rewriting the historical record. This prevents abandoned coordination from blocking explicit migration while old workers still retain their original settings.

### Recovery when both IndexedDB settings and the preference copy are unavailable

The launcher enumerates startup-ready/full-offline Cache Storage manifests,
orders them by publication timestamp descending (channel is not considered),
and attempts verified, compatible candidates in that order. Recovery uses a
page-local cache-only preferences mode: no IndexedDB read or write is required
for activation, boot, or subsequent version UI reads. Explicit startup recovery
buttons download and verify their requested release, then use this same mode.
They no longer retry the unavailable database before recording a choice.

Recovered preference records carry a marker so an older primary record with an
unknown, higher revision cannot undo recovery when IndexedDB becomes readable.
Once a later explicit preference change copies that marker into IndexedDB,
normal revision comparison applies between the two copies again. Startup does
not repair or overwrite IndexedDB. “Retry installed release” explicitly permits
a fresh IndexedDB probe.

A missing modern storage-target pointer plus other live tab locks still requires
older tabs to save and close before migration. Candidate activation retains the
normal worker drain and exclusive lifetime lock; cache selection alone never
authorizes concurrent notebook writers.
