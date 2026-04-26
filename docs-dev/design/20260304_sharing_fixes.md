# Google Drive Sharing Fixes

## Scope

This document proposes changes for shared Google Drive links in the web app.

The target fixes are:

1. When a user opens a shared Google Drive file link, automatically add the
   containing folder to Explorer if it is not already mounted.
2. When Google Drive auth cannot be obtained, log the failure with `appLogger`
   and surface it in the UI.
3. If the app is refreshed and auth later becomes available, finish loading the
   pending file/folder automatically.

## Summary

The core problem is not only "missing auth". It is that the app has no durable
representation of "a Drive link should be processed, but we cannot process it
yet."

The recommended design is:

- Introduce a small persisted queue of pending Drive link intents.
- Keep that queue in `localStorage`, not IndexedDB.
- Add one coordinator that owns resolving Drive URLs into mounted folders and
  opened local notebook mirrors.
- Treat inbound `?doc=` as one-shot input:
  - read it on page load
  - enqueue a Drive intent
  - remove it from the URL immediately
- Stop using `?doc=` as the steady-state current notebook identifier.
- Persist the current notebook separately in `localStorage` for refresh/reload
  restore.
- Surface auth-blocked intents with both:
  - `appLogger.error(...)`
  - a persistent Drive loading/status tab with a retry action

## Current Problems

### 1) `CurrentDocContext` resolves too early

Today `CurrentDocContext` treats any non-local/non-fs/non-contents `doc`
parameter as durable current-doc state and immediately tries to resolve it.

That is too early because:

- it does not know whether the URI is a Drive file or folder
- it does not fetch Drive metadata first
- it does not mount the parent folder into Explorer
- it cannot recover cleanly when auth is unavailable

This is the main reason refresh behavior is fragile.

### 2) No durable pending-work model

If `ensureAccessToken()` fails, the app can log or throw, but it does not keep a
first-class record that says:

- which Drive URI still needs processing
- what action should happen once auth is available
- whether the failure is retryable

Without that, refresh and delayed-auth flows are ad hoc.

### 3) URL state is overloaded

Today `?doc=` is doing two different jobs:

- inbound shared-link handoff
- current notebook persistence

Those have different lifecycles.

- a shared link should be consumed once and then cleared
- current notebook restore should survive reload and be app-owned

Keeping both in one query param complicates retry, refresh, and auth recovery.

### 4) Explorer only reflects completed mounts

`WorkspaceContext` persists mounted roots, but only after the folder has already
been resolved to a local mirrored folder. There is no place to persist
"mount this Drive folder later once auth works."

## Requirements

- A shared Drive file link should open the file and mount its containing folder.
- A shared Drive folder link should mount that folder.
- If auth is blocked or cancelled, the user should see a clear, persistent
  error, not only a console failure.
- A refresh must not lose the intended Drive action.
- A normal refresh/reload should restore the notebook the user was already
  working on, even after `?doc=` has been consumed and removed.
- The implementation should reuse existing persistence:
  - `WorkspaceContext` for actual mounted roots
  - `LocalNotebooks` for mirrored Drive files/folders
- We should avoid adding another Dexie schema unless there is clear benefit.

## Recommendation

## 1) Add a persisted Drive link intent queue

Add a new lightweight store for unresolved Drive link work.

Suggested shape:

```ts
type DriveIntentStatus =
  | "pending"
  | "waiting_for_auth"
  | "processing"
  | "completed"
  | "failed";

type DriveIntentAction =
  | "open_shared_file"
  | "mount_shared_folder";

interface DriveLinkIntent {
  id: string;
  remoteUri: string;
  action: DriveIntentAction;
  source: "url" | "workspace" | "manual";
  status: DriveIntentStatus;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}
```

Key points:

- The queue stores intent, not mirrored content.
- It should dedupe by `(action, remoteUri)`.
- Completed intents should be removed once their side effects are reflected in:
  - `WorkspaceContext`
  - `CurrentDocContext`
  - `LocalNotebooks`

## 1a) Prefer a plain service with commands + subscription

This coordinator should primarily be a plain TypeScript service, not a React
context and not a DOM-event bus.

Recommended shape:

```ts
interface DriveLinkCoordinator {
  enqueue(remoteUri: string, source?: "url" | "manual"): Promise<void>;
  processPending(): Promise<void>;
  retryAuthAndProcess(): Promise<void>;
  getSnapshot(): DriveLinkCoordinatorSnapshot;
  subscribe(listener: () => void): () => void;
}
```

Where `DriveLinkCoordinatorSnapshot` contains:

- pending intents
- per-intent status
- recent errors
- whether auth is currently blocking progress

Why this shape fits the repo better:

- it matches the logging runtime pattern: command methods plus `subscribe(...)`
- it keeps orchestration logic outside React rendering
- it gives UI a clean way to render a synthetic status tab
- it avoids a generic `window` `CustomEvent` bus for core app flow

React should host the service and subscribe to it, but the service itself
should remain plain application code.

## 2) Persist intents in `localStorage`

Use `localStorage` for this queue.

Why `localStorage` is the right default here:

- the queue is tiny
- entries are simple JSON
- it must be available very early during startup
- it must survive refresh
- it does not need Dexie transactions or rich queries

IndexedDB is still the right place for mirrored notebook and folder data. It is
not the right place for a small startup coordination queue.

## 3) Add a single Drive link coordinator

Add a new coordinator near app startup, for example:

- `app/src/contexts/DriveLinkIntentContext.tsx`, or
- `app/src/components/DriveLinkCoordinator.tsx`

This coordinator should own all of the following:

- reading the initial `?doc=` URL
- enqueueing a Drive intent when the URL points at Drive
- clearing `?doc=` from the URL once it has been captured
- retrying pending intents when auth becomes available
- resolving file vs folder metadata
- mounting folders into Explorer
- opening the resolved local notebook for shared files
- clearing/completing intents when work succeeds

Recommended app placement:

- after `GoogleAuthProvider`
- after `WorkspaceProvider`
- after `NotebookStoreProvider`
- after `CurrentDocProvider`

This gives the coordinator access to auth, workspace, local mirror storage, and
current document routing.

## 3a) Use explicit injected APIs for side effects

The coordinator should not expect UI surfaces to infer required actions from raw
events. When work succeeds, it should directly invoke the relevant injected app
APIs.

Recommended injected capabilities:

```ts
type DriveLinkCoordinatorDeps = {
  ensureAccessToken: () => Promise<string>;
  updateFolder: (remoteUri: string, name?: string) => Promise<string>;
  addFile: (remoteUri: string, name?: string) => Promise<string>;
  addWorkspaceItem: (localUri: string) => void;
  getWorkspaceItems: () => string[];
  openNotebook: (localUri: string) => Promise<void> | void;
  fetchDriveItemWithParents: typeof fetchDriveItemWithParents;
  log: typeof appLogger;
};
```

The important design point is:

- storage mutations should happen by calling storage APIs directly
- workspace mounting should happen by calling workspace APIs directly
- notebook opening should happen by calling the explicit notebook-navigation API

Those are commands, not inferred side effects.

## 3b) Coordinator should depend on the Drive library, not `gapi`

To stay consistent with [docs-dev/design/20260224_drive.md](/Users/jlewi/git_runmeweb/docs-dev/design/20260224_drive.md),
the coordinator should not call Google-specific browser APIs directly.

In particular, it should not:

- load `gapi`
- issue raw Google REST requests
- parse Google auth/browser client details itself

Instead, all Drive-facing work should go through the storage/Drive library
layer under `app/src/storage/` and any future extracted Drive client
abstraction.

At minimum, the coordinator needs these Drive capabilities:

- resolve whether a shared URI is a file or folder
- fetch metadata for the shared item
- fetch parent folder metadata for shared files
- mirror a folder into local storage
- mirror a file into local storage

That can be expressed either as:

- methods on `LocalNotebooks` + existing helpers such as
  `fetchDriveItemWithParents(...)`, or preferably
- a higher-level Drive facade/client interface that `LocalNotebooks` itself uses

The key constraint is:

- the coordinator orchestrates
- the Drive library performs Drive operations

This keeps the coordinator testable and aligned with the planned Drive client
abstraction in `20260224_drive.md`.

## 4) Treat `?doc=` as one-shot share input, not current-doc state

For incoming URL state:

- `local://`, `fs://`, and `contents://` should keep current behavior
- Drive URLs should be treated as inbound share intents

Specifically, `CurrentDocContext.resolveFromLocation()` should stop doing this:

- using Drive `?doc=` values as steady-state current-doc state

Instead it should:

- let the Drive link coordinator:
  - read the Drive URL
  - enqueue the corresponding intent
  - remove `doc` from the URL immediately
  - resolve the intent into mounted folders and/or a local mirrored file later

This keeps "shared-link intake" separate from "current document state."

## 5) Persist current notebook outside the URL

Yes, the app should persist the current notebook separately, preferably in
`localStorage`.

Suggested shape:

```ts
interface CurrentNotebookState {
  uri: string | null;
  updatedAt: string;
}
```

Recommended behavior:

- when `setCurrentDoc(localUri)` succeeds, persist the current notebook URI
- on startup, if there is no consumable `?doc=` share link, restore from
  `localStorage`
- if a consumable `?doc=` share link is present, it takes precedence over the
  stored current notebook
- once the share intent completes, update the stored current notebook to the
  resolved local URI

This gives the app a clear precedence order:

1. shared-link input from URL
2. previously active notebook from localStorage
3. no active notebook

The value persisted here should be the app's actual current notebook URI:

- `local://...` for Drive-backed mirrored notebooks
- `fs://...` for filesystem notebooks
- `contents://...` for contents-backed notebooks

We should not persist raw Drive share URLs as the ongoing current notebook
state. Those belong in the Drive intent queue, not in the current notebook
storage slot.

## 6) Define the processing flow

### Shared file link

When the URL contains a Drive file link:

1. Enqueue `open_shared_file(remoteUri)`.
2. Coordinator attempts `ensureAccessToken()`.
3. If auth succeeds:
   - fetch file metadata and parent metadata
   - mirror the direct parent folder with `store.updateFolder(parent.uri, ...)`
   - add that local folder root to `WorkspaceContext` if not already present
   - mirror the file with `store.addFile(file.uri, file.name)`
   - call `setCurrentDoc(localFileUri)`
   - mark intent complete
4. If auth fails:
   - mark intent `waiting_for_auth`
   - surface the failure in UI
   - retry later when auth becomes available

Recommended scope for Explorer auto-mount:

- mount the direct containing folder of the shared file
- do not automatically mount the full ancestor chain as separate roots

That keeps Explorer useful without cluttering it.

### Shared folder link

When the URL contains a Drive folder link:

1. Enqueue `mount_shared_folder(remoteUri)`.
2. Coordinator attempts `ensureAccessToken()`.
3. If auth succeeds:
   - mirror the folder with `store.updateFolder(remoteUri, resolvedName?)`
   - add the local folder URI to `WorkspaceContext` if not already present
   - mark intent complete
4. If auth fails:
   - mark intent `waiting_for_auth`
   - surface the failure in UI

## 7) Retry automatically after auth becomes available

The coordinator should watch auth state and retry pending intents when either of
these occurs:

- `setAccessToken(...)` succeeds
- `ensureAccessToken()` later succeeds after a previous failure

This is what fixes the refresh case:

- page loads with shared Drive URL
- first auth attempt fails or is blocked
- intent remains persisted
- user refreshes or later completes OAuth
- coordinator sees valid auth and completes the queued work

## Auth and UI Design

## 1) Extend `GoogleAuthContext` with auth status

`ensureAccessToken()` is not enough by itself. The app also needs observable
status for UI and retry behavior.

Suggested additions:

```ts
type GoogleAuthStatus =
  | "unknown"
  | "ready"
  | "requesting"
  | "blocked"
  | "failed";

interface GoogleAuthErrorState {
  code:
    | "popup_blocked"
    | "popup_closed"
    | "oauth_error"
    | "config_missing"
    | "script_load_failed";
  message: string;
  retryable: boolean;
}

interface GoogleAuthContextType {
  ensureAccessToken: () => Promise<string>;
  setAccessToken: (token: string, expiresIn?: number) => void;
  authStatus: GoogleAuthStatus;
  authError: GoogleAuthErrorState | null;
  clearAuthError: () => void;
}
```

We do not need perfect Google-specific classification on day one. We do need a
stable way to distinguish:

- retryable auth failures
- non-retryable config/setup failures

## 2) Log failures with `appLogger`

Any auth failure that blocks Drive-link processing should emit a structured
`appLogger.error(...)`.

Suggested scopes/codes:

- `scope: "storage.drive.auth"`
- `code: "DRIVE_AUTH_TOKEN_FAILED"`

- `scope: "storage.drive.share"`
- `code: "DRIVE_SHARED_LINK_PROCESS_FAILED"`

Useful attrs:

- `remoteUri`
- `action`
- `retryable`
- `authStatus`
- `error`

## 3) Use a persistent status tab instead of popup-only UI

A toast alone is not sufficient because it disappears while the intent remains
blocked, and a banner is still somewhat disconnected from the actual notebook
loading workflow.

Recommended UI behavior:

- optionally show an error toast on first failure
- open a persistent status tab while there is any Drive intent that is:
  - `pending`
  - `waiting_for_auth`
  - `processing`
  - `failed`

This tab should explain that the app is trying to load shared notebook content
and should display:

- list of pending remote URIs
- current status per URI
- recent error messages
- whether auth is currently blocked/unavailable
- a `Retry` button that re-triggers auth and intent processing
- optionally a `Dismiss`/`Close` action once there are no active intents

Suggested title:

- `Loading Shared Notebook`
- or `Drive Link Status`

Suggested empty/success behavior:

- once all intents are completed successfully, close the status tab
- if the user manually closes it while intents are still active, it may be
  reopened automatically on the next failure or retry

This is preferable to a popup because it matches the user's mental model: they
opened a notebook link and the app is showing the notebook-loading state in the
same tab strip where notebook content normally appears.

## 4) Model the UI as a synthetic app tab, not a fake notebook

The current tabs in `Actions.tsx` are notebook-oriented and assume the active
tab usually maps to a real notebook URI that can be loaded from a store.

Because of that, the Drive loading UI should be treated as a synthetic app tab,
not as a normal mirrored notebook.

Suggested identity:

- `system://drive-link-status`

This synthetic tab should be rendered by the tab container, but it should not:

- be persisted as an open notebook in `NotebookContext`
- be loaded through `NotebookStore.load(...)`
- be mirrored into `LocalNotebooks`

Instead, it should be driven directly from the Drive intent queue/coordinator
state.

This means the status tab should subscribe to coordinator state. The
coordinator does not need to emit a special "open status tab" event. The UI can
derive whether the tab should exist from the snapshot:

- if there are active/pending/failed intents, render the synthetic tab
- otherwise hide it

## Detailed Ownership

### `WorkspaceContext`

Remains the source of truth for mounted Explorer roots that are already
resolved.

It should not become the pending-intent queue.

Explorer should not need to subscribe to coordinator-specific events to learn
that a folder was processed.

Instead:

1. coordinator calls `store.updateFolder(remoteUri, ...)`
2. coordinator calls `addItem(localFolderUri)` on `WorkspaceContext`
3. `WorkspaceExplorer` re-renders because `workspaceUris` changed

That keeps Explorer aligned with its current contract: it reacts to workspace
state, not to a separate event stream.

### `LocalNotebooks`

Remains the source of truth for mirrored local Drive files/folders.

It should not decide when to retry auth-blocked URL processing.

It remains responsible for mirroring Drive items locally. Its existing
`local-notebook-updated` event remains useful for metadata refresh cases such as
rename, but it should not become the primary coordination mechanism for shared
link processing.

### Drive link coordinator

Owns unresolved Drive-link work and transitions from:

- raw remote URL
- to resolved local mirror
- to mounted workspace root and/or opened local notebook
- to status-tab state while processing is incomplete

The coordinator may expose state changes via `subscribe(...)`, but those
notifications are for UI observation, not for command routing.

### `CurrentDocContext`

Owns current doc selection and URL synchronization, but should no longer be
responsible for shared-link intake.

It should instead own:

- the active notebook URI
- persistence of that URI to `localStorage`
- restore-from-storage behavior when no inbound share link is present

Notebook tab opening should continue to happen via explicit current-doc
navigation:

- coordinator resolves a shared file to `local://...`
- coordinator calls `openNotebook(localUri)` / `setCurrentDoc(localUri)`
- `NotebookContext` and `Actions` react through their existing current-doc flow

This is more consistent with `docs-dev/design/20260224_saveas.md`, which already prefers
an explicit notebook-opening API over an evented implicit flow.

## Alternatives Considered

### A) Reuse `WorkspaceContext.items` as the queue

Rejected.

Why:

- workspace roots represent completed mounted state
- pending Drive work is not the same thing
- mixing them would blur "desired future action" with "actual current mount"
- it would complicate folder removal semantics

### B) Store pending intents in IndexedDB

Rejected for now.

Why:

- the queue is small and simple
- startup access matters more than query power
- adding Dexie schema/migration is unnecessary overhead

If we later need richer retry history or many pending actions, we can revisit
this.

### C) Keep current eager `store.addFile(doc)` behavior and patch around it

Rejected.

Why:

- it still loses the distinction between unresolved remote URL and resolved
  local mirror
- it still does not solve "unknown file vs folder before auth"
- it makes refresh behavior harder to reason about

### D) Keep current-doc persistence in the URL

Rejected.

Why:

- it overloads the URL with both share intake and restore state
- it forces auth-sensitive Drive resolution into routing
- it makes it harder to clear one-time shared-link input
- it is less robust than app-owned persisted state for reload restore

### E) Use coordinator-emitted DOM events as the primary integration path

Rejected.

Why:

- Explorer and notebook tabs already have explicit state owners
- using events for imperative actions would duplicate those state systems
- DOM events make dependency flow harder to test and reason about
- they are less typed than a plain service API with injected callbacks

Events/subscriptions are still appropriate for exposing coordinator status to UI
observers, but not as the main command path.

### F) Let the coordinator depend directly on the real Google Drive API

Rejected.

Why:

- it would bypass the storage/Drive abstraction direction already documented in
  `20260224_drive.md`
- it would make E2E testing depend on live Google behavior
- it would make fake-server injection much harder
- it would duplicate logic already belonging in the Drive/storage layer

## Implementation Sketch

### New pieces

- `app/src/lib/driveLinkIntents.ts`
  - localStorage persistence helpers
  - dedupe helpers
  - intent status updates

- `app/src/components/DriveLinkCoordinator.tsx`
  - hosts the coordinator service inside the app lifecycle
  - processes queued intents
  - consumes and clears inbound `?doc=` share links
  - retries when auth becomes available

- `app/src/lib/driveLinkCoordinator.ts`
  - plain service/state machine
  - command methods + `getSnapshot()` + `subscribe(...)`

- `app/src/components/DriveAuthBanner.tsx`
  - replaced by a status-tab view component, e.g.
    `app/src/components/DriveLinkStatusTab.tsx`

### Modified pieces

- `app/src/contexts/CurrentDocContext.tsx`
  - stop using Drive `?doc=` as steady-state current-doc state
  - persist current notebook URI to `localStorage`
  - restore current notebook from `localStorage` when no share link is present

- `app/src/contexts/GoogleAuthContext.tsx`
  - expose auth status and last error
  - log token acquisition failures with `appLogger`

- `app/src/App.tsx`
  - wire in the coordinator host and status-tab rendering

- `app/src/components/Workspace/WorkspaceExplorer.tsx`
  - simplify current "shared file parent mounting" logic so it cooperates with
    the new coordinator instead of owning delayed URL resolution itself

## Testing Plan

This design should follow the repository’s existing testing architecture in
[docs-dev/architecture/testing.md](/Users/jlewi/git_runmeweb/docs-dev/architecture/testing.md):

1. define the workflow as a CUJ markdown file
2. implement a browser scenario under `app/test/browser/`
3. run the scenario through the standard CUJ runner
4. capture screenshots/video artifacts for human review

## CUJ plan

Add a CUJ document, for example:

- `docs-dev/cujs/open-shared-drive-link.md`

Proposed coverage:

- open app with shared Drive file link
- file parent folder is mounted into Explorer
- notebook opens after resolution
- auth-blocked flow shows the status tab
- retry/auth completion finishes loading
- shared folder link mounts folder without opening a notebook

This is consistent with the existing CUJ model described in
`docs-dev/architecture/testing.md`.

### Unit tests

- enqueue/dequeue/dedupe of Drive intents
- resuming pending intents from `localStorage`
- consuming `?doc=` and removing it from the URL after enqueue
- retry on auth status transition from blocked to ready
- `subscribe(...)` reflects coordinator status transitions
- status tab appears while intents are pending or blocked
- retry button re-triggers auth and intent processing
- shared file link mounts parent folder and opens local mirrored file
- shared folder link mounts folder without opening a notebook
- current notebook restore from `localStorage` when no share link is present
- share-link input takes precedence over stored current notebook

### Integration tests

- app loads with `?doc=<drive-file-url>` and valid auth:
  - `doc` is removed from the URL after enqueue
  - parent folder appears in Explorer
  - file opens

- app loads with `?doc=<drive-file-url>` and auth popup blocked:
  - `doc` is removed from the URL after enqueue
  - `appLogger.error` is emitted
  - persistent status tab appears
  - intent remains queued

- app reloads after auth becomes available:
  - queued intent is processed
  - folder/file load completes automatically
  - status tab closes once work completes

- app reloads with no share link:
  - previously active current notebook is restored from `localStorage`

## E2E testability requirement

To make this testable end-to-end, the coordinator must not be coupled to the
real Google Drive API.

The E2E flow should use a fake Drive implementation behind the Drive client
library. That matches the existing direction in:

- [docs-dev/design/20260224_drive.md](/Users/jlewi/git_runmeweb/docs-dev/design/20260224_drive.md)
- [testing.md](/Users/jlewi/git_runmeweb/testing.md)

Recommended test architecture:

1. the browser app is configured to use the fake Drive backend
2. the Drive client/storage layer talks to that fake backend
3. the coordinator invokes the Drive/storage layer normally
4. the browser scenario verifies the resulting UI behavior

This gives us a realistic end-to-end test without depending on external Google
services.

## Fake-drive alignment

The coordinator should be written so its tests can inject a fake or stubbed
Drive facade directly.

Separately, browser CUJ/E2E tests should run against a fake backend wired
through runtime configuration, not by mocking the coordinator itself.

That gives two useful test layers:

- unit tests with a fake in-memory Drive facade
- browser CUJ tests with a fake Drive server behind the real client path

## Recommended v1 boundaries

For the first pass, keep the feature narrow:

- only process Drive URLs originating from shared links / startup URL state
- persist a small localStorage queue
- clear shared-link query params after enqueue
- persist steady-state current notebook separately in `localStorage`
- mount the direct parent folder for shared files
- show one persistent status tab for in-flight or blocked Drive intents

Do not add:

- multi-level ancestor auto-mount
- background exponential backoff
- IndexedDB intent persistence
- a generic cross-backend pending operation framework

## Decision

Use a small persisted Drive link intent queue in `localStorage`, processed by a
single coordinator. Treat `?doc=` as one-shot share input: enqueue it, then
remove it from the URL. Persist the steady-state current notebook separately in
`localStorage` so reload restores the user's working state without conflating it
with share-link intake. Expose in-flight and blocked work in a synthetic status
tab rather than relying on popups. Extend auth handling so failures are both
logged and shown persistently in that tab. This is the smallest design that
cleanly fixes the reported issues without keeping Drive routing entangled with
URL state.
