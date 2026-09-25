# Parallel Drive operations with exclusive file claims

## Decision

Run up to K asynchronous Drive jobs in the existing SharedWorker, with K = 10
by default. Only one job may claim a notebook at a time. An independent notebook
may use another slot immediately. `LocalNotebooks` accepts
`runtime.driveSyncConcurrency` to configure another positive integer, including
20; this is an owner construction setting, not a separate limit for each tab.

Keep the existing delaying queue and extend it with a processing map and file
claim set. The SharedWorker remains the single coordinator for its origin. Ten
slots mean ten concurrent async operations, not ten JavaScript worker threads.
I/O can overlap while the JavaScript event loop handles bookkeeping serially.

## Problem

PR #391 introduced a single active job and a global `__all_drive_work__` lock.
Together they serialize unrelated notebooks, including every network round trip
inside an attempt. A slow upload delays an uncached notebook open even when the
files share no state. PR #397 fixed retry/deduplication issues but deliberately
left this serialization intact. Both the queue and global lock must change.

The previous design had independent per-file debounced subscriptions. The
SharedWorker should preserve that independence while coalescing work across tabs.

## Identities and invariants

Separate the work key from the exclusion key:

| Operation | Work key | Exclusive claim |
| --- | --- | --- |
| Source reconciliation | `source:local://file/id` | `local://file/id` |
| Markdown projection | `markdown:local://file/id` | `local://file/id` |
| IPYNB projection | `ipynb:local://file/id` | `local://file/id` |
| Durable creation without a local notebook | `create:operation-id` | `create:operation-id` |

Work keys deduplicate equivalent requests. The file claim also excludes different
operation kinds for the same notebook. A source job includes any required
initial upstream creation for that local notebook. Standalone Save As creation
uses its durable operation ID until it has a result. Local URIs are the existing
canonical mirror identities; this does not add cross-origin/profile coordination
or solve multiple independently created mirrors of the same remote file.

1. At most K jobs are active in one owner queue.
2. At most one active job holds a given file claim.
3. Repeated queued additions update one work item. Scans only ensure missing work
   exists; they do not dirty active work or replace explicit callbacks.
4. Edits during processing mark one follow-up pass. Completion moves that pass
   to the tail. Each attempt reads current durable state, not a captured payload.
5. Source and derived work retain separate retry deadlines and error policies.
6. A job waiting for its file claim does not consume an execution slot.

## Claim and completion

The scheduler selects a ready, unclaimed file, records its claim synchronously,
and then starts its async callback. There is no `await` between checking and
claiming. No other message handler can interleave those bookkeeping steps.
Completion releases the processing entry and file claim in `finally`, then fills
available slots. Success, transient failure, permanent failure and synchronous
throws all take that completion path.

This follows [client-go's queue](https://github.com/kubernetes/client-go/blob/master/util/workqueue/queue.go):
Get moves an item into the processing set; Done releases it and requeues dirty
work. It is not a time-expiring lease. Do not release a claim merely because a
UI request times out: the underlying Drive write may still be running. A hung
request retains its slot until it settles. Any future request timeout must abort
and settle the underlying operation before allowing another same-file write.

Closing the queue stops dispatch, rejects queued explicit callers, and discards
pending in-memory work. Active attempts retain their claims and settle their
callers normally. Closing does not cancel I/O. Worker restart rebuilds pending
work from durable notebook state and creation receipts; claims, deadlines and
failure counts remain in memory. Idempotent creation and existing upstream
revision/conflict checks still handle uncertain outcomes across worker death.

## Scheduling and recovery

Use a bounded pool of promises driven by one pump, rather than polling worker
loops. On completion or enqueue, refill all free slots. Schedule one timer for
the earliest delayed, unclaimed file. Ready siblings of an active file wait for
its completion event; they must not cause a timer or microtask busy loop.

Explicit opens/syncs get the next available slot. After three foreground jobs,
admit a ready background job, preserving FIFO order within each class. This
reduces interactive backlog without starving automatic saves. No active request
is preempted; an open can still wait if all ten jobs are busy. Cached OPFS opens
continue to bypass Drive entirely.

Keep per-operation debounce, the two-minute automatic save interval, auth
recovery and exponential retry backoff. Delayed items occupy no slot. Retain
#397's permanent-conversion filtering and local-data preservation. K bounds
concurrent attempts, not requests per second. Start at 10, observe queue wait and
Drive rate-limit failures, then tune K. An account-wide rate limiter is a separate
possible follow-up, not a reason to restore global serialization.

Remove the global network lock. Retain existing per-file coordination in source,
export and recovery paths, including compatibility Web Locks outside the owner.
Standalone creation gains a lock keyed by durable operation ID, so removing the
global lock does not remove its cross-controller exclusion. Existing local OPFS
commit queues remain separate; network latency must not block local editing.

## TypeScript alternatives

[p-queue](https://github.com/sindresorhus/p-queue) provides bounded concurrency
and priorities. It would still need file claim, dirty-state, delayed retry and
persistent recovery integration. A semaphore wrapped around per-file locks is
also insufficient: all K slots could be occupied by jobs waiting for one file.
Extend the small existing queue to claim a file before consuming capacity. Do
not add another package or multiple SharedWorkers for this change.

## Diagnostics and validation

Keep waiting work-key depth and eligible-to-dequeue latency history. Exclude all
active jobs from waiting depth. Add the configured capacity and number of ready
jobs blocked by an active file. Show active count as `N / K`; active duration is
the oldest active attempt. Histogram wait includes waiting for a file claim but
excludes debounce, retry backoff and execution after claiming.

Tests cover K = 10 and 20; replacement of freed slots; duplicate additions; source
and exports sharing a claim; independent progress; edits during an attempt;
explicit follow-up after an edit; transient/permanent failure; auth recovery;
shutdown; foreground fairness; and same-file requests through two MessagePorts.
Storage integration tests verify default K = 10 and retained creation/file locks.
The real Chromium SharedWorker test starts a second uncached file through another
tab while the first is blocked on credentials, then checks offline edit/reopen
and exact OPFS persistence across restart. Offline availability is disabled in
both tabs: one unavailable tab must not suppress another tab's valid credentials.
Run the full app suite and `runme run build test`; compare type-check failures
with unchanged main. Review scheduling and shutdown paths separately from tests.

No database migration or storage reset is needed. Existing SharedWorkers keep
running their loaded code until replaced; after deployment, close/reopen all
same-origin Runme tabs to use the new scheduler. Do not clear site data.
