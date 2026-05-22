# Multi-Tab Notebook Ownership

Date: 2026-05-20

Issue: https://github.com/runmedev/web/issues/215

## Summary

Support multiple browser tabs by making notebook ownership explicit.

The product rule is intentionally narrow:

1. A notebook can be open for editing in only one browser tab at a time.
2. Different browser tabs can show different notebooks.
3. A closed tab must not keep a notebook blocked.
4. If a notebook is already open elsewhere, the current tab should show a clear
   blocked state and offer a cooperative takeover path.

This avoids cross-tab notebook synchronization. Each editable notebook has one
writer, and other tabs must either open a different notebook or take ownership.

## Browser Coordination Choice

Use the Web Locks API as the correctness primitive.

`navigator.locks` is designed for same-origin tabs and workers to coordinate
exclusive access to shared resources. A lock is automatically released when the
holding execution context goes away, which directly handles the "closed tab
blocks forever" failure mode.

Use `BroadcastChannel` for live cross-tab messages:

- "please close this notebook" requests
- "ownership released" notifications
- best-effort "focus your tab" requests

Use IndexedDB for best-effort ownership metadata that the UI can inspect. The
lock is authoritative; metadata is descriptive and may be stale.

Do not use a service worker as the ownership authority. A service worker is
useful for fetch/cache orchestration, but its lifecycle is event-driven and not
a reliable always-running single process for editor ownership. A `SharedWorker`
is closer to the "one coordinator process" idea, but support is newer and it is
still unnecessary if Web Locks owns exclusivity.

References:

- Web Locks API:
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- Broadcast Channel API:
  https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API
- SharedWorker:
  https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker
- Service worker lifecycle:
  https://web.dev/articles/service-worker-lifecycle

## Current State

The current app has two pieces of global browser state that conflict with real
multi-tab behavior:

- `CurrentDocContext` persists `runme/currentDoc` in `localStorage`.
- `NotebookContext` persists `runme/openNotebooks` in `localStorage`.

Because `localStorage` is shared by same-origin tabs, all tabs converge on the
same current document and same open notebook list. This is exactly what must
change for "different tabs can show different open documents."

Relevant current files:

- `app/src/contexts/CurrentDocContext.tsx`
- `app/src/contexts/NotebookContext.tsx`
- `app/src/components/Actions/Actions.tsx`
- `app/src/components/SidePanel/SidePanel.tsx`
- `app/src/components/Workspace/WorkspaceExplorer.tsx`
- `app/src/components/AppConsole/AppConsole.tsx`

There is also an architectural coupling that should be fixed before adding tab
ownership: the app does not cleanly separate "load a notebook into memory" from
"show this notebook tab."

Today notebook opening is mostly reactive:

```text
setCurrentDoc(uri)
  -> NotebookContext effect observes current doc
  -> loadNotebookIntoLocalMirror(uri)
  -> ensureNotebook(...)
  -> new NotebookData(...)
  -> selected tab changes as a side effect
```

That makes `currentDoc` serve both as the visible selection and as the command
channel for loading. Multi-tab ownership needs an imperative open path because
ownership must be acquired before an editable notebook is considered open.

Some of the stable-local-URI behavior already exists in `LocalNotebooks`:

- `addFile(remoteUri, name)` creates or returns a stable `local://file/...`
  record for a remote file before notebook content is necessarily loaded.
- `load(localUri)` attempts best-effort sync and returns an empty notebook if
  the local record has no `doc` yet.

The missing piece is an explicit notebook session model that can represent:

- a notebook tab that is selected/visible
- a local mirror URI that is known and stable
- a `NotebookData` model that may be loaded, loading, blocked, or failed
- auth/loading errors that should be shown in the tab instead of collapsing the
  selection

## Proposed Model

### Tab Identity

Create one in-memory tab id at app startup:

```ts
const tabId = crypto.randomUUID();
```

Do not use `localStorage` for tab identity. Do not rely on persisted
`sessionStorage` identity for correctness because duplicated browser tabs can
clone session storage. A reload can receive a new tab id; ownership will be
reacquired through Web Locks.

Expose the tab id through a small `TabIdentityContext` or a module-level
singleton.

### Per-Tab Open State

Move current/open editor state from shared `localStorage` to per-tab state:

| State | Current storage | Proposed storage |
| --- | --- | --- |
| current document | `localStorage["runme/currentDoc"]` | `sessionStorage` plus React state |
| open notebooks | `localStorage["runme/openNotebooks"]` | `sessionStorage` plus React state |
| active cell | `localStorage["runme/notebook-active-cells"]` | keep shared; keyed by notebook URI and harmless |

The URL `?doc=` should still be accepted as an initial open request, but after
startup the selected document is tab-local.

This does not mean keying `localStorage` by `tabId`. `localStorage` is shared by
all same-origin tabs, so storing values like `runme/openNotebooks/<tabId>` would
still create shared durable records that need garbage collection. It would also
make duplicated-tab behavior harder to reason about.

The intended split is:

- use `sessionStorage` as the per-tab restore store for the current tab's open
  notebook list and selected notebook
- hydrate normal React state from `sessionStorage` on startup
- use Web Locks plus the IndexedDB ownership table for cross-tab coordination

If a browser duplicates a tab and clones `sessionStorage`, that cloned open list
is only a restore hint. Each notebook still has to reacquire its Web Lock before
it can become editable in the duplicated tab.

### Reload vs New Tab

There is no fully reliable browser API that says "this is the same physical tab"
across every reload, restore, duplicated tab, and crash-recovery path.

The practical signals are:

- `sessionStorage` survives reloads and restores in the same top-level browsing
  context, which makes it the right place to restore the open notebook list for
  a refreshed tab.
- `performance.getEntriesByType("navigation")[0].type` can distinguish
  `"reload"`, `"navigate"`, and `"back_forward"` for the current page load.
- `pageshow` / `pagehide` expose whether a page is moving through the
  back/forward cache via `PageTransitionEvent.persisted`.

Those signals should guide restore behavior, but they should not decide
ownership. On startup, treat `sessionStorage` as a list of notebooks this tab
wants to restore, then reacquire Web Locks one notebook at a time. If another
tab still owns one of those notebooks, show the blocked state instead of opening
it.

If we need to keep using `localStorage` for compatibility, use it only as a
legacy initial-open hint or as a shared ownership metadata store. Do not use
shared `localStorage` as the source of truth for the tab's open editor list.

### Notebook Session Model

Move the business logic currently inside `NotebookProvider.ensureNotebook` and
the `currentDoc` effects into a notebook session owner. This can start inside a
refactored `NotebookProvider`, but it should have a controller-like API so it
can later move out of React cleanly.

The session model should own:

- `openNotebooks`
- `currentNotebookUri`
- loaded `NotebookData` instances keyed by local URI
- pending/blocked/error state per open notebook
- restore/persist for the tab-local open list

Suggested snapshot:

```ts
type NotebookTabState =
  | "resolving"
  | "blocked"
  | "loading"
  | "loaded"
  | "error";

interface OpenNotebookEntry {
  uri: string;              // stable local://file/... when known
  requestedUri: string;     // original URI from URL, Drive, fs, or local source
  name: string;
  state: NotebookTabState;
  errorMessage?: string;
  owner?: NotebookOwnershipRecord;
}

interface NotebookSessionSnapshot {
  openNotebooks: OpenNotebookEntry[];
  currentNotebookUri: string | null;
}
```

The key split is:

- `openNotebook(uri)`: resolves/creates the local mirror URI, acquires ownership,
  creates or loads `NotebookData`, adds an open entry, and selects it.
- `selectNotebook(localUri)`: changes the visible tab only. It must not load,
  mirror, or acquire ownership.
- `closeNotebook(localUri)`: removes the open entry, disposes the model, releases
  ownership, and selects a same-tab fallback.

Showing a notebook should be possible even before the notebook content is
loaded. For example, a Drive URL with expired credentials should still become a
visible tab with a stable local URI when possible, then render an auth/loading
state in that tab until the load can complete.

### Stable Local URI Resolution

Before a notebook can be opened or owned, resolve it to the app-facing local
URI:

```text
remote Drive URI / fs URI / local URI
  -> local://file/<id>
```

Rules:

- If the input is already `local://file/...`, use it directly.
- If the input has an existing local mirror record by `remoteId`, return that
  local URI without requiring fresh upstream credentials.
- If the input is a Drive or filesystem URI and enough metadata is available,
  create a local placeholder record and return its new local URI.
- If creating the placeholder needs credentials that are unavailable, keep a
  `resolving` or `error` tab entry keyed by the original request until the user
  can authenticate and retry.

`LocalNotebooks.addFile(remoteUri, name)` already implements the first part of
this behavior for remote files. The session model should use that as the stable
URI reservation primitive instead of waiting for full notebook content to load.

### Ownership Record

Add a small Dexie database, for example `runme-tab-coordination`, with a table
keyed by canonical notebook URI.

```ts
interface NotebookOwnershipRecord {
  notebookUri: string;
  ownerTabId: string;
  ownerLabel: string;
  ownerUrl: string;
  ownerStartedAt: string;
  epoch: string;
}
```

The `epoch` is a random UUID generated each time ownership is acquired. It lets
late messages from an old owner be ignored after takeover.

The canonical ownership key should be the editable local notebook URI:

```text
local://file/<id>
```

Drive and filesystem URLs should be normalized through the existing local
mirror flow first, then ownership should be acquired for the resulting local
URI.

### Ownership Lease

Add an ownership manager module, for example:

```text
app/src/lib/tabCoordination/notebookOwnership.ts
```

Suggested API:

```ts
type AcquireResult =
  | { status: "acquired"; lease: NotebookLease }
  | { status: "blocked"; owner: NotebookOwnershipRecord | null };

interface NotebookLease {
  notebookUri: string;
  tabId: string;
  epoch: string;
  release(): void;
  isCurrentOwner(): Promise<boolean>;
}

interface NotebookOwnershipManager {
  acquire(notebookUri: string): Promise<AcquireResult>;
  takeOver(notebookUri: string): Promise<AcquireResult>;
  release(notebookUri: string): void;
  getOwner(notebookUri: string): Promise<NotebookOwnershipRecord | null>;
  subscribe(listener: () => void): () => void;
}
```

`acquire` should call:

```ts
navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
  if (!lock) {
    return blocked;
  }
  // Write ownership record and hold the callback open until release().
});
```

The lock callback must return a promise that resolves only when the notebook is
closed or ownership is otherwise released. That keeps the lock held for the
whole edit session.

### Metadata, Not Heartbeats

Do not add a heartbeat protocol for initial multi-tab correctness.

Web Locks already answer the important liveness question: if the owner tab is
closed, reloaded, or crashes, the lock is released by the browser. A heartbeat
would add timeout tuning and background-tab throttling issues without improving
the exclusive-writer guarantee.

Ownership metadata should be written when the lock is acquired and deleted on
clean release. If metadata cleanup fails, the next opener should ignore stale
metadata when the Web Lock is acquirable.

The rules are:

- if the Web Lock is unavailable, the notebook is owned elsewhere, even if the
  metadata is missing or stale
- if the Web Lock is available, the current tab may acquire ownership and
  overwrite any stale metadata
- metadata should never block opening by itself

If later UX needs "last seen" or richer diagnostics, add a heartbeat as a
separate enhancement. It should remain display-only.

### Opening a Notebook

All notebook-open paths must route through one async function:

```ts
openNotebook(uri, options)
```

The function should:

1. Resolve or reserve a stable local mirror URI for the requested URI.
2. Select or create an open tab entry for that URI.
3. Acquire the ownership lock for the local URI once known.
4. Create or retrieve the `NotebookData` model for the local URI.
5. Load notebook content into `NotebookData` when storage/auth is available.
6. If blocked or auth fails, keep the tab selected and render the blocked/error
   state instead of dropping the current selection.

Callers that currently call `setCurrentDoc` directly should be moved onto this
path:

- workspace explorer file clicks
- Drive link coordinator
- App Console `app.openNotebook(...)`
- Runtime `appState.openNotebook(...)`
- URL `?doc=` processing

The tab strip and open-notebooks sidebar should call `selectNotebook` for
notebooks already open in the same tab.

### Closing a Notebook

Closing an open notebook in this tab should:

1. Stop rendering the notebook.
2. Dispose the `NotebookData` entry if it exists.
3. Release its Web Lock lease.
4. Delete its ownership record if the epoch still matches.
5. Broadcast `owner-released`.
6. Select a same-tab fallback notebook, or clear `currentNotebookUri`.

Use `pagehide` and `beforeunload` for best-effort release, but do not depend on
those events for correctness. The Web Lock release on context shutdown is the
important behavior.

### Blocked Notebook UX

When opening is blocked, `Actions` should render an explicit blocked state
instead of the notebook editor:

```text
Notebook is already open in another browser tab

<name>
Owned by: Tab opened at 10:42 AM

[Focus other tab] [Take over]
```

`Focus other tab` is best effort. It sends a BroadcastChannel message to the
owner; the owner calls `window.focus()`. Browsers may ignore focus requests.

`Take over` is cooperative:

1. Broadcast `close-notebook-request` with notebook URI and requester tab id.
2. Owner closes the notebook, releases the lease, and sends
   `close-notebook-ack`.
3. Requester retries `acquire`.

If the owner does not respond, leave the notebook blocked for the initial
implementation. A later explicit "Force take over" action could use Web Locks
`steal: true`, but that should be a separate decision because it requires save
and mutation paths to verify the ownership epoch before every write.

Do not automatically steal locks.

### AppKernel and Runtime Mutations

The runtime APIs should only expose notebooks owned by the current tab.

Change `runme.getCurrentNotebook()`, `runme.notebooks`, `app.openNotebook`, and
AppKernel mutation helpers so they resolve only owned notebooks. Mutations
against an unowned or blocked URI should throw a clear error:

```text
Notebook local://file/... is open in another browser tab.
```

`NotebookData` persistence should also guard writes by asking the ownership
manager whether the current tab still owns the notebook URI and epoch.

## Implementation Plan

1. Refactor `NotebookProvider` around an explicit notebook session API:
   `openNotebook`, `selectNotebook`, `closeNotebook`, `getNotebookData`, and a
   subscription snapshot.
2. Move `ensureNotebook`, `loadNotebookIntoLocalMirror`, and current-doc loading
   effects behind that session API.
3. Decouple selected tab state from loaded model state so auth/loading failures
   can render in the selected tab.
4. Convert `CurrentDocContext` and `NotebookContext` restore state from
   shared `localStorage` to tab-local session restore.
5. Update `WorkspaceExplorer`, `DriveLinkCoordinatorHost`, `AppConsole`, URL
   handling, and `appState.openNotebook` to call `openNotebook`.
6. Keep tab strip and open-notebooks sidebar selection on `selectNotebook`.
7. Add `TabIdentityContext` and `NotebookOwnershipManager`.
8. Add `runme-tab-coordination` Dexie schema and ownership record helpers.
9. Add ownership acquisition/release to `openNotebook` and `closeNotebook`.
10. Add blocked-notebook UI in `Actions` and sidebar indicators in
   `SidePanel`.
11. Guard AppKernel/runtime notebook mutation APIs with ownership checks.
12. Add tests for ownership acquire/block/release/cooperative-takeover behavior.
13. Add browser tests that open two same-origin pages and verify that the same
   notebook cannot be edited in both.

## Test Plan

Unit tests:

- stable local URI resolution returns an existing mirror without loading content
- opening a notebook can create a selected tab before `NotebookData` is loaded
- selecting a notebook does not load, mirror, or acquire ownership
- acquire succeeds when no other tab holds the lock
- acquire returns blocked when another tab holds the lock
- release deletes the ownership record only for the matching epoch
- stale metadata does not block when the Web Lock is available
- runtime mutation rejects when ownership is missing

Component tests:

- blocked notebook state renders owner metadata and takeover controls
- tab-local open notebook lists do not mirror across simulated tabs
- closing a notebook releases its lease and selects the expected fallback

Browser tests:

- open notebook A in tab 1, attempt notebook A in tab 2, verify blocked UI
- open notebook B in tab 2 while notebook A remains open in tab 1
- close tab 1, then open notebook A in tab 2 without manual cleanup
- click takeover in tab 2 and verify tab 1 closes notebook A
- verify App Console mutation in a non-owner tab fails clearly

## Migration

No notebook content migration is required.

The old shared keys should stop driving current/open editor state:

- `runme/currentDoc`
- `runme/openNotebooks`

For one release, startup may read these keys as a legacy initial open request in
the first loaded tab, then write only the new per-tab/session state. Do not keep
writing the legacy keys after this change.

## Risks

- Web Locks requires a secure context. `localhost` is acceptable for local
  development, and production is HTTPS.
- Browser focus requests may be ignored. The UX should describe focus as best
  effort.
- `BroadcastChannel` messages are not durable. That is fine because ownership
  correctness comes from Web Locks and IndexedDB state.
- Force takeover is intentionally out of scope for the initial implementation.
  It is only safe if save and mutation paths verify ownership epoch before
  writing.

## Recommendation

Use Web Locks for exclusive notebook ownership, BroadcastChannel for live tab
coordination, and IndexedDB records for owner metadata. Refactor current/open
notebook UI state to be tab-local, then route every notebook-open operation
through ownership acquisition.
