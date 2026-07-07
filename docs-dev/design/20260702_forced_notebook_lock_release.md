# Forced Notebook Lock Release

Date: 2026-07-02

Builds on:

- `docs-dev/design/20260520_multi_tab_support.md`
- `docs-dev/design/20260603_readonly_secondary_notebook_tabs.md`

## Summary

Add a cooperative takeover path for notebooks that are already open for writing
in another browser session.

The current ownership model is correct but incomplete. Web Locks prevent two
same-origin tabs from editing the same notebook at the same time, and secondary
tabs can open the notebook read-only. A user cannot currently ask the owner tab
to give up its write lease. That creates friction when Codex loses track of the
browser tab that owns the notebook lock.

We will add a "Request write access" action in the read-only tab. The action
sends a same-origin coordination message for the notebook URI. Every live
session receives the message, and only the session that currently holds the
notebook lease responds. That owner session saves pending notebook changes,
releases its Web Lock lease, and keeps the notebook open read-only. The
requester then retries ownership acquisition and becomes the writer if the lock
is available.

This is a cooperative force, not lock stealing. The owner tab still performs the
save before release, which preserves the single-writer invariant and avoids
data loss.

## Current State

`NotebookDataController.openNotebook()` resolves every requested notebook to a
stable `local://file/...` URI before ownership is evaluated.

For write access, the controller asks `NotebookOwnershipManager.acquire()` for
an exclusive Web Lock. If acquisition succeeds, the controller creates an
editable `NotebookData` model and wraps its save store with an ownership check.
Autosave is debounced in `NotebookData`, and `flushPendingPersist()` can force a
pending save before a transition.

If acquisition is blocked, the controller opens the notebook read-only by
default. Read-only notebooks can be inspected by the UI and AppKernel read APIs,
but notebook mutations, runs, deletes, and persistence are rejected.

`NotebookOwnershipManager` writes descriptive owner metadata to IndexedDB:

```ts
interface NotebookOwnershipRecord {
  notebookUri: string
  ownerTabId: string
  ownerSessionId?: string
  ownerLabel: string
  ownerUrl: string
  ownerStartedAt: string
  epoch: string
}
```

The Web Lock remains the ownership authority. IndexedDB metadata is only used to
explain who appears to own the notebook. It is not used to route or authorize
force-release requests because it may be stale.

## Goals

- Let a user in one session request write access from the session that currently
  owns the notebook.
- Save the owner session's pending notebook changes before it releases the
  ownership lease.
- Keep the owner session open read-only after release when possible.
- Reload the former owner's read-only view after the requester acquires the
  lease so both sessions show the latest persisted notebook state.
- Preserve the single-writer guarantee.
- Keep the takeover protocol same-origin and browser-local.
- Make failure modes visible when the owner tab cannot release the lock.

## Non-Goals

- Do not add collaborative editing or live document synchronization.
- Do not use IndexedDB metadata as a fallback lock.
- Do not build a server-side lock broker.
- Do not add live synchronization or merge edits into stale read-only views.
  The former owner performs one full reload after ownership transfers.
- Do not use Web Locks `steal` in v1. Stealing can revoke the authoritative lock
  before the owner has saved or updated its local state.

## Decision

Use `BroadcastChannel` for notebook-targeted cooperative force-release requests
and acknowledgments.

The requester broadcasts a request for `notebookUri`. Every session receives
the message. Each session asks its local `NotebookOwnershipManager` whether it
currently holds the lease for that URI. Only the current owner accepts the
request. It then:

1. blocks new notebook mutations and new executions for that notebook
2. cancels active executions for that notebook
3. flushes pending notebook persistence while the lease is still valid
4. releases the ownership lease
5. converts its local `NotebookData` model to read-only
6. broadcasts a release result

The requester waits for the release result or for an `owner-released` ownership
message, then calls `openNotebook(localUri)` again. Normal Web Lock acquisition
decides whether takeover succeeded.

This keeps Web Locks as the only authority. Stale IndexedDB metadata cannot
cause a request to miss the real owner or target the wrong session. The
coordination protocol only asks the current owner to take actions it could
already take locally by closing or reopening the notebook.

## Protocol

Reuse the existing `runme-notebook-ownership` `BroadcastChannel`, or replace it
with a small typed wrapper around that channel. The protocol should be explicit
because the channel will carry more than owner-acquired and owner-released hints.

```ts
type NotebookOwnershipMessage =
  | {
      type: 'force-release-request'
      requestId: string
      notebookUri: string
      requesterTabId: string
      requesterSessionId?: string
      requesterLabel: string
      requesterUrl: string
      createdAt: string
      expiresAt: string
      observedOwner?: NotebookOwnershipRecord | null
    }
  | {
      type: 'force-release-result'
      requestId: string
      notebookUri: string
      ownerTabId: string
      ownerSessionId?: string
      ownerEpoch: string
      status: 'released' | 'not-owner' | 'busy' | 'failed'
      message?: string
      releasedAt?: string
    }
  | {
      type: 'owner-acquired' | 'owner-released'
      record: NotebookOwnershipRecord
    }
```

The request targets only the notebook. `observedOwner` is optional diagnostic
context captured when the requester sends the message. It can help the UI render
useful labels, but it must not decide which session handles the request.

The result includes the releasing owner's `ownerTabId`, `ownerSessionId`, and
`ownerEpoch` so the requester can correlate the release with the owner it last
observed. These fields are response metadata, not routing inputs.

Every message should be ignored when:

- `notebookUri` does not match a local open notebook
- `requestId` has already been processed
- `createdAt` / `expiresAt` is outside the accepted clock window

The owner should additionally ignore a request when the current tab does not
hold a live lease for `notebookUri`. If the tab holds a lease, the current lease
epoch is the epoch used in the result. The request does not need to name that
epoch.

The owner should process at most one force-release request per notebook at a
time.

## Requester Flow

The UI should offer `Request write access` when the current notebook is
read-only because another tab owns it. Owner metadata improves the label, but
it is not required.

Flow:

1. User clicks `Request write access`.
2. The requester retries normal Web Lock acquisition once. If the lock is
   already free, it reloads persisted state and becomes editable without
   broadcasting a force-release request.
3. If acquisition is still blocked, the requester reads the latest owner
   metadata from `NotebookOwnershipManager.getOwner(localUri)` for display and
   diagnostics. Missing metadata does not block the request.
4. The requester sends `force-release-request` for `localUri`.
5. The UI shows a pending state such as `Requesting write access from
   <ownerLabel>...` when owner metadata exists, or `Requesting write access...`
   when it does not.
6. The requester waits for:
   - `force-release-result` with `status: "released"`
   - `owner-released` for the same notebook
   - a timeout
7. On release, the requester calls `openNotebook(localUri)` and selects the tab.
8. If acquisition succeeds, the notebook becomes editable.
   Its `owner-acquired` message tells the former owner to reload the notebook
   from persisted storage in read-only mode.
9. If acquisition is still blocked, the tab remains read-only and shows the
   latest owner metadata.
10. If the request times out, the tab remains read-only and shows an error with
   an explicit retry action.

The timeout should be short enough to avoid trapping the user in a spinner. Ten
seconds is a reasonable initial value. The timeout does not imply lock
ownership. The requester should not automatically retry after timeout. The user
must click retry or request write access again.

The requester always retries normal acquisition once before broadcasting. This
handles a crashed owner whose Web Lock was released while its IndexedDB metadata
remained stale.

## Owner Flow

`NotebookDataController` should expose a focused method for this path:

```ts
interface ForceReleaseRequest {
  requestId: string
  notebookUri: string
  requesterLabel: string
  createdAt: string
  expiresAt: string
}

type ForceReleaseResult =
  | { status: "released" }
  | { status: "not-owner" }
  | { status: "busy"; message: string } // another release is already in progress
  | { status: "failed"; message: string }

forceReleaseNotebook(request: ForceReleaseRequest): Promise<ForceReleaseResult>
```

The method should:

1. Verify the current tab holds a live lease for `notebookUri`.
2. Mark the notebook as `releasePending` so UI controls and runtime APIs reject
   new mutations immediately.
3. Cancel active executions for the target notebook.
4. Call `NotebookData.flushPendingPersist()`.
5. Release the lease through `NotebookLease.release()`.
6. Remove the write save store from the model.
7. Mark the model and open entry `readOnly: true`.
8. Preserve the open tab and current selection in the owner session.
9. Broadcast `force-release-result` with the released lease epoch and let the
   existing `owner-released` message fire from the ownership manager.
10. When a different session later broadcasts `owner-acquired` for the same
    notebook, reload the notebook from persisted storage and keep it read-only.

The save must happen before the lease is released. The current save wrapper
checks `lease.isCurrentOwner()`, so releasing first would cause the flush to fail
or silently skip the only durable write opportunity.

`releasePending` should be separate from `readOnly`. During release, the tab is
still the owner and can save, but user and AppKernel mutations should already be
blocked. The UI should render this state as locked mode.

The owner should not show a confirmation prompt before entering locked mode.
Force release is an explicit action from another same-origin session, and the
feature is meant to recover from lost sessions. Prompting the owner would fail
the recovery case when the owner tab is alive but not visible to the user or
Codex.

The post-transfer reload is triggered by the authoritative acquisition path,
not by the force-release result. The former owner handles `owner-acquired` only
when it no longer holds a lease and its local model is read-only. It replaces
the model contents from the local notebook store while preserving the existing
tab and selection. The reload must not call `acquire()` or install a save store.
If the reload fails, the tab remains read-only and shows a refresh error; it
must not fall back to the former in-memory model as editable state.

## Active Execution Policy

Forced release cancels active executions for the target notebook.

Rules:

- The owner closes active runner streams and aborts AppKernel executions for the
  target notebook.
- For Jupyter executions, the owner requests a kernel interrupt and closes the
  channels socket. Interrupt is best-effort and bounded to two seconds so an
  unreachable runner cannot indefinitely block takeover.
- The owner records a clear terminal output or status message on affected cells
  before the final flush when possible.
- After cancellation starts, execution callbacks must not append more outputs.
- The owner then flushes and releases.

This makes takeover bounded and predictable. It may interrupt work in the owner
session, but the action is explicitly a forced release and is meant to recover
from lost sessions.

## UI Contract

Read-only banner:

```text
This notebook is read-only because <ownerLabel> has write access.

[Request write access]
```

Pending request:

```text
Requesting write access from <ownerLabel>...
```

Owner locked mode:

```text
Another session requested write access. Saving changes and switching this
notebook to read-only.
```

Locked mode should render the notebook with all editing and execution controls
disabled. It should show the latest in-memory notebook contents while the owner
cancels executions and flushes pending saves. After the lease is released, the
same tab remains open and renders the notebook read-only.

Failure states:

- `The other session did not respond. The notebook is still read-only.`
- `The other session is already processing a write-access request.`
- `The other session could not save changes before releasing the lock.`

If the owner metadata contains `ownerSessionId`, the UI may display it in
diagnostic details. The primary user-facing label should remain human-readable:
for example `Runme tab opened at 10:42 AM` or the existing `ownerLabel`.

## Runtime Contract

Runtime and AppKernel mutations must reject while `releasePending` is true.
`releasePending` is the runtime state behind the owner tab's locked mode.

The rejection message should be explicit:

```text
Notebook local://file/... is releasing its write lock for another session.
```

Read APIs remain allowed during `releasePending` and after the notebook becomes
read-only.

`notebooks.list()` should expose enough state for Codex to understand the mode:

```ts
interface NotebookSummary {
  uri: string
  name: string
  readOnly: boolean
  releasePending?: boolean
  owner?: NotebookOwnershipRecord | null
}
```

## Failure Modes

Owner tab is closed or crashed:

- The Web Lock is released by the browser.
- The requester retry succeeds once the lock is available.
- Stale IndexedDB owner metadata must not block acquisition.

Owner tab exists but Codex cannot find it:

- The owner still receives the BroadcastChannel request if the page is alive.
- The owner saves, releases, and becomes read-only without Codex needing to
  control that tab.

Owner metadata is stale:

- The requester still broadcasts by notebook URI.
- The live owner self-identifies by checking its current lease.
- Sessions that do not hold the lease ignore the request.

Owner tab is alive but does not run the new protocol:

- The requester times out and remains read-only.
- The user can close the owner tab manually or reload it after the feature ships.

Owner save fails:

- The owner keeps the write lease.
- The owner returns `status: "failed"`.
- The requester remains read-only.

Requester loses the race after release:

- Another tab may acquire the lock first.
- The requester handles this through the normal blocked/read-only path.
- The former owner reloads after whichever session broadcasts the successful
  `owner-acquired` event.

Former owner reload fails:

- The former owner remains read-only.
- The UI shows an error and offers a manual refresh.
- The new owner keeps the lease; reload failure does not affect ownership.

## Implementation Plan

1. Add typed ownership-channel helpers and message tests.
2. Extend `NotebookOwnershipManager` with `requestForceRelease()` and a
   subscription path for force-release requests.
3. Add `releasePending` to notebook snapshots and open notebook entries.
4. Add `NotebookDataController.forceReleaseNotebook()`.
5. Add a `NotebookData` execution-cancel API for runner streams, AppKernel
   executions, and Jupyter kernel interrupts/channels sockets.
6. Block UI and AppKernel mutations while `releasePending` is true.
7. Add the read-only banner `Request write access` action.
8. Add pending, timeout-error, busy, and failed states in the read-only UI.
9. Add owner-side locked-mode UI.
10. Reload the former owner's read-only model after another session acquires
    the notebook.
11. Add tests for request, release, retry acquisition, post-transfer reload,
    timeout, and save failure.

## Test Plan

Unit tests:

- force-release request is ignored by tabs that do not hold the notebook lease
- force-release request is ignored when it is expired
- owner flushes pending persistence before releasing the lease
- owner keeps the lease when flush fails
- owner marks the notebook read-only after successful release
- owner enters locked mode immediately without showing a confirmation prompt
- owner cancels active executions before flushing and releasing
- execution callbacks cannot append outputs after cancellation starts
- requester retries `openNotebook(localUri)` after a release result
- former owner reloads persisted contents after another session acquires the
  released notebook and remains read-only
- former owner ignores `owner-acquired` reload hints while it holds the lease
- former owner remains read-only and exposes a refresh error when reload fails
- requester remains read-only and shows a retryable error after timeout
- stale owner metadata does not block reacquisition
- `releasePending` rejects notebook mutations and execution starts

Browser tests:

- open a notebook editable in tab A and read-only in tab B
- request write access from tab B
- verify tab A saves, releases, and becomes read-only
- verify tab A renders locked mode during release without prompting
- verify tab B becomes editable
- verify tab A reloads tab B's persisted state and remains read-only
- verify a non-responsive owner produces a timeout error and requires user retry
- verify active executions are canceled before release

## Recommendation

Implement cooperative forced release over `BroadcastChannel`. Keep Web Locks as
the authority, save before release, and convert the old owner to read-only after
the lease is dropped. Broadcast requests by notebook URI and let the live owner
self-identify through its current lease. For v1, cancel active executions during
forced release so the recovery path is bounded and useful for lost Browser-tab
sessions. Reload the former owner's read-only view after the new writer acquires
the lease.
