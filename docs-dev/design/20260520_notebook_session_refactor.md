# Notebook Session Refactor

Date: 2026-05-20

Related:

- https://github.com/runmedev/web/issues/215
- `docs-dev/design/20260520_multi_tab_support.md`

## Summary

Refactor notebook tab/session state before adding multi-tab ownership.

This document scopes a single PR. The PR should be deployable on its own and
should avoid storage migrations or multi-tab behavior changes.

The immediate problem is that the app does not cleanly distinguish:

1. **Opening/loading a notebook**: resolving a requested URI, creating or finding
   a stable local mirror URI, creating `NotebookData`, and loading content.
2. **Showing a notebook**: selecting which already-open tab is currently visible.

Today `CurrentDocContext` mixes those concerns. Setting current doc is both a
selection update and the command that indirectly causes `NotebookContext` to
load or create a `NotebookData` model.

This refactor introduces a concrete global `NotebookDataController`:

```ts
const controller = getNotebookDataController();

await controller.openNotebook(uri);
controller.closeNotebook(localUri);
controller.getNotebookData(localUri);
```

`CurrentDocContext` remains the selection API, but it is narrowed to only mean
"which notebook is currently visible." It should no longer trigger notebook
loading.

`NotebookContext` becomes a React adapter over the controller.

## PR Scope

In scope for this PR:

- add `NotebookDataController`
- move the `NotebookData` registry out of React component refs
- expose `openNotebook`, `closeNotebook`, `getNotebookData`, and controller
  snapshots through `NotebookContext`
- keep `CurrentDocContext` as the selection propagation mechanism
- stop using current-doc changes as the way to load notebooks
- keep existing `localStorage` keys and restore behavior

Out of scope for this PR:

- moving restore state from `localStorage` to `sessionStorage`
- adding Web Locks or cross-tab ownership
- making `LocalNotebooks` a singleton
- changing `LocalNotebooks.load()` empty-doc behavior
- removing `CurrentDocContext`

## Motivation

Multi-tab support will eventually need a single `openNotebook` path before Web
Lock ownership can be added safely. This PR does not add locks; it creates the
explicit open path that later lock acquisition can attach to.

The current reactive path is backwards for that:

```text
setCurrentDoc(uri)
  -> NotebookContext effect observes current doc
  -> loadNotebookIntoLocalMirror(uri)
  -> ensureNotebook(...)
  -> new NotebookData(...)
```

That means any caller that wants to open a notebook smuggles the command through
selection state. It also makes it difficult to show a notebook tab when content
cannot be loaded yet, for example when a Drive URL is known but credentials have
expired.

The desired path is imperative:

```text
openNotebook(uri)
  -> resolve or reserve stable local URI
  -> create/load NotebookData when possible
  -> return local URI plus load state
```

Showing the notebook remains the job of `CurrentDocContext`:

```text
setCurrentDoc(localUri)
  -> propagate visible notebook selection to UI
```

Most user-facing open flows will call both:

```text
const result = await openNotebook(uri)
setCurrentDoc(result.localUri)
```

That keeps document loading/model ownership separate from UI selection while
still making Explorer, URL handling, and App Console flows straightforward.

The full user-facing sequence is:

```text
openNotebook(uri)
  -> resolve or reserve stable local URI
  -> create/load NotebookData when possible
setCurrentDoc(localUri)
  -> render resolving/loading/error/loaded state in that tab
```

Selection becomes a simpler operation:

```text
setCurrentDoc(localUri)
  -> update visible tab only
```

## Current State

### In-Memory Notebook Model

`NotebookData` is the in-memory model for one notebook.

File:

- `app/src/lib/notebookData.ts`

It owns:

- URI and display name
- the `parser_pb.Notebook` proto
- cell index/cache
- subscriptions and snapshots
- autosave scheduling
- active streams and Jupyter sockets

`NotebookData` is created in `NotebookProvider.ensureNotebook(...)`.

### Loaded Notebook Registry

`NotebookProvider` tracks loaded model instances in:

```ts
const storeRef = useRef<Map<string, StoreEntry>>(new Map());
```

where:

```ts
type StoreEntry = {
  data: NotebookData;
  unsubscribe: () => void;
  loaded: boolean;
};
```

The map is keyed by notebook URI.

### Open Notebook List

`NotebookProvider` separately tracks open tabs:

```ts
const [openNotebooks, setOpenNotebooks] = useState<NotebookStoreItem[]>([]);
```

This list is persisted to shared `localStorage["runme/openNotebooks"]`.

### Current Selection

`CurrentDocContext` tracks:

```ts
currentDoc: string | null
```

It restores from:

- `?doc=...`
- `localStorage["runme/currentDoc"]`

It writes back to `localStorage["runme/currentDoc"]` and clears the URL query
param.

After this refactor, `CurrentDocContext` should keep tracking the visible
selection, but it should stop owning open/load behavior. It may remain the
shared propagation mechanism used by the tab strip, sidebar, App Console, and
code mode.

### Current Coupling

Notebook loading is triggered by selection:

- `WorkspaceExplorer` calls `setCurrentDoc(item.uri)`.
- `DriveLinkCoordinatorHost` calls `setCurrentDoc(localUri)`.
- App Console runtime `app.openNotebook(uri)` calls `setCurrentDoc(uri)`.
- `NotebookContext` observes `getCurrentDoc()` and loads/mirrors/ensures a
  notebook for that URI.

This makes `currentDoc` both:

- selected visible tab
- open/load command

## Existing Stable Local URI Behavior

Some of the desired URI reservation behavior already exists.

`LocalNotebooks.addFile(remoteUri, name)`:

- looks up a file by `remoteId`
- returns the existing `local://file/...` URI if found
- otherwise creates a new local file record with empty `doc`
- returns the new stable local URI

`LocalNotebooks.load(localUri)`:

- attempts best-effort sync
- if the local record has no `doc`, returns an empty notebook

This means we already have a way to represent "we know this file and have a
stable local URI, but content may not be loaded yet." The notebook session
should use that explicitly instead of treating content load as the same event
as tab selection.

## Target Model

### NotebookDataController

Add a vanilla TypeScript singleton:

```text
app/src/lib/notebookDataController.ts
```

Use a concrete class first. Do not add a separate interface until we have a
second implementation or a real testability problem. TypeScript's structural
typing is enough for tests that need small fakes.

Suggested exports:

```ts
export class NotebookDataController {
  static getInstance(): NotebookDataController;

  getSnapshot(): NotebookDataControllerSnapshot;
  subscribe(listener: () => void): () => void;

  configureStores(options: {
    localNotebooks: LocalNotebooks | null;
  }): void;

  openNotebook(
    uri: string,
    options?: { name?: string },
  ): Promise<OpenNotebookResult>;
  closeNotebook(localUri: string): string | null;

  getNotebookData(localUri: string): NotebookData | undefined;
  getOpenNotebooks(): OpenNotebookEntry[];
}

export function getNotebookDataController(): NotebookDataController;
export function __resetNotebookDataControllerForTests(): void;
```

Make the singleton explicit rather than hiding state in React component refs.
This matches the repo's existing manager pattern (`getRunnersManager`,
`getJupyterManager`, `getHarnessManager`, `getCodexProjectManager`).

`NotebookProvider` should configure the controller with the current
`LocalNotebooks` instance and expose React hooks over the controller snapshot.

### NotebookData Storage

`NotebookDataController` owns the `NotebookData` registry. Move the current
`NotebookProvider.storeRef` model map into the controller, while preserving the
current placeholder behavior.

```ts
type NotebookDataHandle = {
  data: NotebookData;
  unsubscribe: () => void;
};

class NotebookDataController {
  private readonly notebooks = new Map<string, NotebookDataHandle>();
  private openNotebooks: OpenNotebookEntry[] = [];
  private listeners = new Set<() => void>();
}
```

The `notebooks` map is keyed by stable local notebook URI:

```text
local://file/<id>
```

Rules:

- `getNotebookData(localUri)` returns `notebooks.get(localUri)?.data`.
- `openNotebook(localUri)` may create a `NotebookDataHandle` with an empty
  notebook and `loaded: false`, matching today's `ensureNotebook` behavior.
- `openNotebook(remoteUri)` first resolves or reserves a local URI through
  `LocalNotebooks`, then uses that local URI as the entry key.
- `closeNotebook(localUri)` unsubscribes the handle, removes it from `notebooks`,
  removes its open list entry, emits a snapshot update, and returns a fallback
  local URI for `CurrentDocContext`.
- `openNotebooks` is metadata for UI tabs; `notebooks` is the loaded model
  registry. They are related but not the same thing.
- loading, blocked, auth-required, and error state belongs on
  `OpenNotebookEntry`, not inside `NotebookData`.

This distinction matters because a notebook can be selected or visible before
its content is loaded. For the first refactor, preserve the current behavior:
`NotebookData` may exist before content is fully loaded, seeded with an empty
notebook proto and later populated by `NotebookData.loadNotebook(...)`.

The UI should not infer readiness from the existence of `NotebookData`. It
should use `OpenNotebookEntry.state` for loading, auth-required, blocked, and
error rendering. A later cleanup can decide whether to stop creating placeholder
`NotebookData` instances.

### Controller Snapshot

```ts
type NotebookTabState =
  | "resolving"
  | "loading"
  | "loaded"
  | "blocked"
  | "error";

interface OpenNotebookEntry {
  uri: string;
  requestedUri: string;
  name: string;
  state: NotebookTabState;
  errorMessage?: string;
}

interface NotebookDataControllerSnapshot {
  openNotebooks: OpenNotebookEntry[];
}
```

`uri` is always the stable `local://file/...` URI for the open notebook. The
controller should not create an `OpenNotebookEntry` until it has a local URI.

For remote inputs, `openNotebook` must either:

1. find an existing local mirror by `remoteId`, or
2. reserve a new local record with `LocalNotebooks.addFile(remoteUri, name)`.

If the controller cannot produce a local URI, the open command should fail
without creating a notebook tab entry. Those failures belong in the existing
status/error flow, not in `openNotebooks`.

`requestedUri` preserves the original command target from URL, Drive, fs, or
local source.

`NotebookContext` should subscribe to this snapshot with `useSyncExternalStore`
and expose hooks for React components. `CurrentDocContext` continues to expose
the selected URI.

### Command Semantics

`openNotebook(uri)`:

1. Normalize or reserve the stable local URI.
2. Create or retrieve a `NotebookData` placeholder for the local URI.
3. Start or perform content load when storage/auth is available.
4. Return the stable local URI plus load state.
5. Do not call `setCurrentDoc`.

`setCurrentDoc(localUri)`:

1. Updates the visible selected notebook URI.
2. Propagates that selection to the tab strip, sidebar, App Console, code mode,
   and other consumers.
3. Persists selection through the existing `CurrentDocContext` behavior.
4. Does not load, mirror, sync, acquire ownership, or create `NotebookData`.

This means callers own intent:

- Explorer file click: `const { localUri } = await openNotebook(uri); setCurrentDoc(localUri)`.
- URL `?doc=` handling: `openNotebook(doc)` then `setCurrentDoc(localUri)` if
  resolution succeeds far enough to produce a tab target.
- Background preloading: call `openNotebook(uri)` without selecting it.
- Tab strip/sidebar: call only `setCurrentDoc(localUri)`.

`closeNotebook(localUri)`:

1. Remove the open entry.
2. Dispose/unsubscribe the `NotebookData` entry if present.
3. Return a same-tab fallback URI so the caller can update `CurrentDocContext`.
4. Persist the open list using the existing `runme/openNotebooks` behavior.

Future multi-tab ownership hooks attach naturally, but are not part of this PR:

- `openNotebook` acquires Web Lock ownership before editable load.
- `closeNotebook` releases ownership.
- blocked ownership becomes `state: "blocked"`.

## Store Dependencies

`NotebookDataController` should depend on `LocalNotebooks`, not directly on
`FilesystemNotebookStore`.

Reasoning:

- `LocalNotebooks` is the app-facing notebook store for editable notebooks.
- `LocalNotebooks.addFile(remoteUri, name)` can reserve a stable local URI for
  Drive and filesystem-backed files.
- `LocalNotebooks.load(localUri)` owns best-effort sync before hydrating
  notebook content.
- `LocalNotebooks` already has `setFilesystemStore(...)` so filesystem sync can
  be wired there.

Therefore controller configuration should be:

```ts
controller.configureStores({
  localNotebooks,
});
```

not:

```ts
controller.configureStores({
  localNotebooks,
  filesystemStore,
});
```

For filesystem opens, the caller can pass the display name it already has from
the explorer:

```ts
await controller.openNotebook(fsUri, { name: item.name });
```

The controller then calls `localNotebooks.addFile(fsUri, name)` and later
`localNotebooks.load(localUri)`. If the filesystem store is not configured yet,
`LocalNotebooks.load` may return cached/empty content or surface an error state;
the controller should not bypass `LocalNotebooks` to talk to the filesystem
store directly.

`LocalNotebooks` is not currently a global singleton. `NotebookStoreInitializer`
constructs it, configures its filesystem store, puts it in React context, and
also stores it on `appState`. `NotebookDataController` could read
`appState.localNotebooks`, but explicit configuration is clearer and easier to
test:

```ts
getNotebookDataController().configureStores({ localNotebooks: localStore });
```

If we later make `LocalNotebooks` itself a singleton, this configuration method
can become a thin no-op wrapper or be removed.

## URL Handling

`?doc=<uri>` should be treated as an open command, not current selection state.

Startup flow:

1. Read `doc` query param.
2. Call `openNotebook(doc)`.
3. If a local tab target is available, call `setCurrentDoc(localUri)`.
4. Clear the query param.
5. Render loading/error/loaded in the selected tab.

Drive shared-link failures should not clear an existing selection. If the app can
reserve or find a local URI, URL handling can select that tab and show
retry/login affordances. If it cannot produce a local tab target yet, keep using
the existing Drive status tab pattern until the user can authenticate and retry.

## Persistence

For this PR, keep the existing persistence behavior.

Current shared keys:

- `runme/currentDoc`
- `runme/openNotebooks`

The controller should read/write the same open-notebook state that
`NotebookContext` uses today, only moving ownership of that logic out of React.
`CurrentDocContext` should continue persisting current selection as it does
today for this PR.

Moving restore state to `sessionStorage` is deferred to a later multi-tab PR.

## Implementation Plan

### 1. Add NotebookDataController

Create `app/src/lib/notebookDataController.ts` and move the loaded model
registry out of React:

- add `notebooks: Map<string, NotebookDataHandle>`
- add `openNotebooks: OpenNotebookEntry[]`
- add `subscribe` / `getSnapshot`
- expose `openNotebook` and `closeNotebook`
- expose `getNotebookData` and `getOpenNotebooks`
- add `configureStores({ localNotebooks })`
- add `__resetNotebookDataControllerForTests`

`NotebookProvider` should become a thin React adapter:

- configure the controller when `LocalNotebooks` changes
- use `useSyncExternalStore` to expose `useNotebookList`
- keep `useNotebookSnapshot` backed by `NotebookData.subscribe`
- forward `openNotebook`, `closeNotebook`, and `getNotebookData`

Keep `CurrentDocContext`, but document and enforce that it is selection-only.

### 2. Move Opening Callers

Change open-command callers to use `openNotebook`:

- `WorkspaceExplorer` file open
- `DriveLinkCoordinatorHost`
- App Console `app.openNotebook(...)`
- `appState.openNotebook(...)`
- URL `?doc=` processing

Keep selection callers on `CurrentDocContext.setCurrentDoc`, but make sure they
only pass local URIs for already-open notebooks:

- notebook tab strip
- open-notebooks sidebar
- close fallback selection
- Explorer/Drive/URL/App Console flows after `openNotebook` returns a local URI

### 3. Stop Loading From Current Selection

Remove the `NotebookContext` effect that treats `getCurrentDoc()` as a load
trigger.

Loading should happen only through `openNotebook`.

### 4. Narrow CurrentDocContext Within Existing Storage

Remove non-selection responsibilities from `CurrentDocContext`:

- stop processing URL `?doc=` inside the provider
- stop registering `appState.openNotebook`
- keep `getCurrentDoc` / `setCurrentDoc` for visible selection

Runtime default notebook resolution can continue reading `getCurrentDoc()`, but
that value should only ever represent a selected local notebook URI.

## Testing

Unit tests:

- `openNotebook(localUri)` creates/loads one `NotebookData`
- `openNotebook(remoteUri)` returns an existing local URI when a mirror exists
- `openNotebook(remoteUri)` does not change current selection by itself
- `setCurrentDoc(localUri)` changes selection without loading or creating a
  model
- `closeNotebook(localUri)` removes the model and returns fallback for
  `CurrentDocContext`
- URL `doc` processing calls `openNotebook` first, then `setCurrentDoc` with
  the resolved local URI

Component tests:

- tab strip selection calls `setCurrentDoc`
- explorer file click calls `openNotebook`
- App Console `app.openNotebook` calls the session open path
- loading/error state can be shown for selected entries without loaded content

Browser tests:

- open a local notebook and switch tabs without losing scroll state
- refresh restores the open notebook session
- Drive auth failure keeps a visible retry/error state instead of clearing the
  selected notebook
