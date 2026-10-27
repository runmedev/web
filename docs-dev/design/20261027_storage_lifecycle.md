# Storage lifecycle and recovery

## Decision

Keep the lifetime Web Lock as the single storage-ownership authority. Keep
release selection durable, but do not require a release-settings transaction to
back up editors or stop the existing worker. Recovery controls and diagnostic
probes must remain available before notebook storage initializes.

A storage restart does not reload pages. Tabs retain their editor models and
pending save batches. The old worker closes; replacements reacquire the same
lifetime lock, validate release admission, and accept the retained batches.
Stopping the worker requires no tab acknowledgement or session-storage write.
Each tab reconnects independently on its next request; idle tabs need not connect
immediately, and there are no tab readiness or reconnect broadcasts.
An editor-save timeout also makes the next request replace the connection, so
recovery does not depend on receiving the old worker's stop notification.
Only app upgrade/reload requires coordinated editor preservation.

The tab owns the save baseline: the snapshot last loaded into the editor or
successfully acknowledged after a save. It prepares immutable operations before
sending them to storage, retaining both the operations and the submitted snapshot
until acknowledgement. Edits typed while waiting belong to the next snapshot.
The worker validates notebook identity and causal dependencies, rejects conflicting
contents under an existing operation ID, and appends only missing operations.
Retrying the identical batch repairs a lost acknowledgement without duplication.
No editor identity search reconstructs a baseline, and no latest merged notebook
is substituted for the tab's actual observed version.

Graceful stop drains admitted work. Force stop requests `self.close()` immediately,
without awaiting storage or network IO. A force request can interrupt a stalled
graceful drain, provided the JavaScript message loop still responds. Other
operations, such as remote notebook creation, retain uncertain-outcome blockers
and are never blindly retried. Editor batches alone have this idempotent contract.

A BroadcastChannel management endpoint starts before lock acquisition and runtime
imports. It reports the current startup phase and elapsed time without reading
IndexedDB. It includes release-database traces before runtime initialization and
host request diagnostics afterward. Version UI
always exposes discovery, stop, force stop, restart and force restart controls.
Discovery describes responding Runme workers, not all workers in the browser.

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

- Only a worker holding `runme-storage-owner-lifetime-v1` opens notebook stores.
- Editor clients explicitly register for recovery; existing clients that send
  notebook RPCs are also participants. Passive launcher/control ports are excluded.
- Storage stop never reloads a tab, discards an editor, or waits for tab votes.
- App reload remains a separate operation with preparation, preservation and
  blockers for uncertain outcomes. Session copies do not survive tab closure.
- Graceful stop drains admitted work. Force stop skips drain and retains unknown
  outcomes. Neither path replays generic mutations or overwrites history with an
  editor snapshot. Only immutable editor batches may be retried automatically.
- A tab advances its baseline only after acknowledgement of the exact submitted
  snapshot. Its pending batch and later editor contents survive transport loss.
- Duplicate operation IDs require identical contents; missing causal history or a
  changed notebook identity rejects the batch without altering OPFS bytes.
- The replacement must reacquire the lifetime lock. Release admission still occurs
  at startup; a restart is not permission to activate a different release.
- Diagnostics read memory, not the database under investigation.

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
