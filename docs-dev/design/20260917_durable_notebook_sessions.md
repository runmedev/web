# Durable notebook sessions

Date: 2026-09-17
Status: Proposed; implementation and regression evidence in the accompanying PR.

[Design notebook in notebooks-lewi-drive](https://web.runme.dev/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1vI0kwmB1tNecaKTJq4gstwdZryuHoFvl%2Fview).

## Goal

Restore the ordered notebook tabs and selection when a desktop host restarts and
recreates a Runme browser tab from its URL. Keep independent tabs independent,
including when a user pastes a session URL or duplicates a browser tab. Bound
the lifetime and size of inactive restore records.

## Current state and prior designs

`NotebookSessionPersistence` stores `runme/openNotebooks` and `runme/currentDoc`
only in sessionStorage. `tabIdentity.ts` originally reads a stored session name
or generates one and overwrites the URL. Remembering `?session=gold-pebble`
therefore does not reconstruct the workspace after the host loses tab storage.

The local Codex logs show eight nightly update/relaunch pairs between September
16 at 6:06 p.m. and September 17 at 7:06 a.m. Pacific. The last installed
26.917.10207 (9732) and relaunched at 3:52:42 a.m. This confirms the restart
trigger; loss of the previous browser sessionStorage is inferred from the empty
workspace and the persistence implementation, not a recovered storage snapshot.

Earlier sources establish constraints we retain:

- [Notebook Session Refactor](https://github.com/runmedev/web/blob/main/docs-dev/design/20260520_notebook_session_refactor.md): controller owns open/load state; CurrentDocContext owns selection; persistence is an adapter.
- [Multi-Tab Notebook Ownership](https://github.com/runmedev/web/blob/main/docs-dev/design/20260520_multi_tab_support.md): sessionStorage isolated per-tab UI state; Web Locks decide ownership. It explicitly rejected durable per-tab keys without garbage collection. This proposal supplies that missing lifecycle.
- [Workspace Document Tabs](https://github.com/runmedev/web/blob/main/docs-dev/design/20260526_workspace_document_tabs.md): restore only supported document kinds; diff and transient status tabs remain ephemeral.
- [Onboarding Checklist Design notebook](https://web.runme.dev/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F116o6DJMjwhQ6SsRcE_YDTzAOmGZ5MULQ%2Fview): explicitly separates sessionStorage open tabs from durable onboarding progress. We change the restore lifetime, not onboarding state.

Drive searches for session/sessionStorage/storage/multi_tab/workspace_document
found the onboarding notebook and index references, but no dedicated session
notebook in the currently searchable Drive account. The repository designs above
are the direct session-design sources.

## Decision: a durable session with one live owner

Keep `?session=<id>` as the resume URL. Persist one small record per session in
localStorage under `runme/notebook-session/v1/<id>`. A session is a set of UI
references, not a notebook copy or authentication identity. Notebook content
continues to live in the existing notebook stores.

The stable ID identifies the durable record. A document's held Web Lock is its
temporary authority to access that record. We do not need an additional URL
parameter or use a heartbeat as a distributed lock. Existing notebook-level
ownership remains independent from session ownership.

New IDs combine a readable name with a UUID. The old name space has only 720
combinations; random reuse must not resurrect someone else's old local session.
Existing short session names remain valid as explicit resume targets.

```ts
interface DurableNotebookSession {
  version: 1;
  lastActiveAt: number;
  currentDoc: string | null;
  openNotebooks: Array<{ uri: string; requestedUri: string; name: string }>;
}
```

Store no cell contents, outputs, owner metadata, credentials or transient errors.
The URL is not a sharing capability: another browser profile or origin has no
record to restore. Notebook sharing continues to use `?doc=` links.

## Copied URLs and Web Locks

Before hydration, request the exclusive `runme:session:<id>` Web Lock with
`ifAvailable: true`. Hold its callback promise for the document's lifetime. A separate short
`runme:session-claim:<id>` lock serializes the claim decision with cleanup, so
GC's temporary ownership is not mistaken for another live tab. Startup waits for
this short gate; GC skips busy gates. Neither holds the gate for the tab lifetime.

| Situation | Behavior |
| --- | --- |
| Ordinary reload | Reclaim the ID and use surviving tab-local state. |
| App restart; sessionStorage empty | Read the URL ID, acquire its lock, restore the durable record. |
| Pasted URL while original is live | Lock is unavailable. Allocate a fresh ID, clear copied restore hints, start empty. |
| Browser Duplicate Tab with cloned sessionStorage | Same lock rule; the clone cannot restore or mutate the original session. |
| Two simultaneous URL restorations | One lock winner restores; the other receives a fresh empty session. |
| URL reopened after original closes | Restore intentionally, within the retention window. |
| URL on another origin/profile | Start with no locally stored workspace; no cross-origin synchronization. |

Reopening after the original closes cannot distinguish intentional restoration from a copied URL after
the owner has closed. That is an explicit product decision: a free resume URL may
resume its saved workspace. Web Locks solve concurrent ownership, not user intent.

Never use `steal`, a lock-query snapshot, timestamps, or localStorage check-then-set
to decide exclusivity. If Web Locks fail or are unavailable, use ephemeral
tab-local state and disable durable restore/writes/cleanup. Live notebook use
continues under its existing ownership rules.

On pagehide, disable durable writes before releasing the session lock. On a
BFCache pageshow, reload so the page claims ownership and hydrates again before
using its old in-memory workspace. The browser also releases locks on crashes.

## Startup and persistence ordering

1. Choose the candidate: surviving tab-local identity, otherwise valid URL ID,
   otherwise a new ID. Keeping existing tab-local identity protects OAuth returns.
2. Acquire ownership or allocate a fresh isolated session. On a fork, clear all
   three tab-list hints: `runme/openNotebooks`, `runme/currentDoc`, and
   `runme/workspaceDocuments`. The latter is a separate workspace cache that
   otherwise resurrects cloned notebook tabs. Clear it for expired sessions too.
   After a URL-only restart, rebuild notebook workspace tabs from the controller.
3. Capture explicit `?doc=` navigation before asynchronous bootstrap consumes
   the query, so onboarding/documentation cannot replace the requested view.
   Initialize the persistence adapter before rendering providers/controllers.
4. Use surviving sessionStorage for a same-tab reload; otherwise read the durable
   record. Import legacy per-tab references once. Never import old shared keys.
5. Hydrate the controller and selection. Preserve retryable notebook entries when
   Drive/auth/content loading fails; do not overwrite the saved list with empty
   startup state or create empty notebook files during recovery.
6. Save reference changes synchronously as one record. Refresh lastActiveAt every
   minute while the page owns the lock.

localStorage fits this small synchronous adapter and avoids a larger asynchronous
controller refactor. Each record is capped at 64 KiB using a conservative UTF-16
size estimate. Oversized or quota-denied writes retain the prior record and log
one structured warning per adapter; the workspace stays usable. No silent truncation.
Malformed records are not hydrated or overwritten while their session is open.

## Retention and cleanup

Inactive records expire after **7 days since last recorded activity**. Keep at
most **50 inactive records**, deleting the least recently active excess records.
Active locked records are exempt from both rules. Thus inactive metadata is
bounded to roughly 3.2 MiB plus keys; currently open sessions add their own bounded
records. A frozen tab's stale heartbeat is never proof of abandonment.

Run cleanup on startup and hourly while Runme is open. Acquire a nonblocking
collector lock, then each candidate's session lock with `ifAvailable: true`.
Re-read the record under its lock; defer records changed since the scan. Delete
only inactive expired/excess records in the v1 session namespace. Never delete
notebooks, OPFS logs, Drive files, comments or auth settings.

This is opportunistic retention: no script runs after all Runme pages close.
Expired metadata is removed on the next visit, and is not restored in the meantime.
Browser storage eviction/clearing can still remove local data. Cross-device or
cross-origin restore requires a separate authenticated synchronization design.

## Alternatives and limits

- sessionStorage alone cannot meet URL-only host restart recovery.
- A single global localStorage open-list recreates cross-tab interference.
- Durable IDs without locks allow copied URLs to overwrite each other.
- TTL heartbeats as ownership misclassify throttled or frozen tabs.
- Server/Drive session synchronization adds identity and sharing semantics and is
  outside this fix. Resume IDs are not authorization tokens.
- An explicitly shared workspace with multiple live writers would require merge
  semantics; this design deliberately gives each live tab independent UI state.

## Validation and acceptance

- Real Chromium persistent-profile test: create notebooks, close the browser,
  relaunch using the same profile and saved URL with no sessionStorage, verify
  order/selection/content, edit, save, and reopen again.
- Paste the same URL while the first tab owns it; verify a new ID and empty list,
  and verify the original durable bytes and notebook state are unchanged.
- Cover cloned sessionStorage, invalid IDs, lock API failures, pagehide writes,
  malformed/quota-denied metadata, empty-list persistence, and migration.
- Test 7-day expiry, the inactive count limit, sleeping lock holders, and a
  session acquired or refreshed during collection. Verify notebook data survives.
- Run the repo build/package tests and relevant app/browser suites.

Web platform references: [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API),
[conditional lock acquisition](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request),
[sessionStorage lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage).
