# Drive reconciliation over-enqueues untouched files

## Bug and evidence

After the SharedWorker storage-owner rollout (#391), opening a mirrored Drive
folder can enqueue notebooks that were never downloaded or edited locally. A
reported session repeatedly logged `queuedCount: 927` while the user edits roughly
ten documents per day. New notebooks remained at “waiting for upstream creation,”
and clicking sync appeared ineffective. The exact composition of those 927 live
records has not been inspected; the placeholder-selection bug is confirmed in code.

Folder discovery calls `addFile`, which persists metadata-only records with empty
`doc`, `md5Checksum`, and `lastRemoteChecksum`, and no `operationLogRef`. The worker's
`needsDriveSourceSync` treated every missing checksum as dirty. That sentinel is
also deliberately used after local OPFS writes, where hashing is deferred until
reconciliation. These two states must not be conflated.

This is a recurring selection bug, not a migration. A pass runs on startup/auth
recovery, connectivity recovery, and every two minutes. “Pass finished” means the
scan/enqueue completed. Its count includes eligible records already in the keyed
queue, not newly added entries or successful syncs. Repeated passes coalesce by
work type and local URI. Source, create, Markdown and IPYNB jobs share the serial
queue; manual sync removes delay but does not prioritize a key ahead of the backlog.

## Fix

In worker mode, an empty checksum is pending source work only if the record has an
`operationLogRef` or a nonempty legacy `doc`. Folder-listing placeholders stay lazy
until explicitly opened. This preserves offline-first opening and avoids reading
OPFS for every record on every scan. The processing path reads the referenced log;
a missing/corrupt log remains a recoverable error, never a clean placeholder.

Keep these existing cases ahead of that check: pending upstream creation and saved
sync errors (including failed first downloads) still retry; conflicts are excluded.
Known hashes still compare against the correct format-specific upstream baseline.
JSON and IPYNB models remain eligible through their cached `doc`.

This PR does not change queue priority. Fixing selection removes spurious work;
manual priority and explicit queued feedback can be addressed separately.

## Drive status monitoring

Collect metrics in `SyncWorkQueue` in the storage owner and expose a read-only,
allowlisted `getDriveQueueMetrics` RPC. The status view polls it every five seconds,
with one request outstanding. Opening the view does not enumerate files or read
OPFS for these metrics. Every tab on the origin sees the same queue history.

- **Queue depth:** distinct waiting work keys, including scheduled/backoff work,
  excluding the active attempt. A same-key follow-up during an active attempt enters
  the waiting count after that attempt finishes. Keep peak depth per ten-second
  bucket for at most one hour. Quiet buckets are filled lazily from the previous
  depth, so metrics are collected even with the status view closed, without a timer.
- **Wait histogram:** `dequeuedAt - readyAt`, recorded once per dequeue attempt.
  Bounds are 100 ms, 1 s, 5 s, 30 s, 2 min and 10 min, plus an overflow bucket.
  Scheduled debounce/backoff is excluded; retries count separately. Credential
  wake-ups and repeated manual requests cannot reset an already-eligible timestamp.
  Processing time and locks acquired after dequeue are excluded.
- **Current state:** waiting, eligible, delayed and active counts, oldest eligible
  wait, and active-attempt duration. These show a stuck backlog even before any
  additional item is dequeued, when a histogram alone would appear healthy.

History and histogram counts are bounded in-memory diagnostics, reset when the
owner restarts. Histogram counts cover that owner lifetime; depth covers at most
one hour. No notebook identifiers/content or credentials are stored in metrics.
The UI states scope, units, bucket semantics and reset time; RPC errors display as
unavailable rather than zero. The protocol version advances to 3 for the added
method. Existing tabs may need reopening together after deployment; do not clear
browser storage.

## Validation

Regression coverage mirrors 1,000 untouched files and reconciles twice, asserting
zero queued source jobs and zero OPFS reads. Separate cases preserve unknown-hash
OPFS logs, cached JSON/IPYNB, dirty known hashes, failed downloads, pending creation,
and conflict exclusion. Existing missing-log coverage keeps recovery visible.

Queue tests cover deduplication, blocked active work, eligibility timing, repeated
wake/manual requests, retry backoff, bounded history, detached snapshots and reset.
MessagePort tests verify both tabs read the same owner's metrics. UI tests cover
both charts, empty observations, polling without overlap, cleanup and errors.

Validation completed on this branch: `runme run build test` passed; the full app
suite passed 1,766 tests, followed by 191 focused tests after adding the Drive
status integration assertion. Both charts were visually inspected using the real
component with synthetic queue data in a local browser preview. The standalone
app typecheck reports the same 125 errors as the base commit, with no additional
file/error-code diagnostics.

Tracking issue: https://github.com/runmedev/web/issues/393.
