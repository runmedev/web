# Workspace Document Tabs

Date: 2026-05-26

Related:

- https://github.com/runmedev/web/issues/220
- `docs-dev/design/20260520_notebook_session_refactor.md`
- `docs-dev/design/20260520_multi_tab_support.md`
- `docs-dev/design/20260426_getAllRendersRefbug.md`

## Summary

Introduce a generic workspace document/tab model so the main tab strip can host
notebooks, notebook diffs, Drive status, and future non-notebook views.

The notebook session refactor already made the most important prerequisite:
notebook model ownership moved out of React view state and into
`NotebookDataController`. We should continue that direction, but the next owner
should not be another notebook-specific controller.

The main decision is:

- `NotebookDataController` owns notebook data, loading, save behavior, and
  notebook runtime handles.
- `CurrentDocContext` owns the selected document URI.
- A new workspace document controller owns the open document URI list, tab
  order, and generic tab metadata.
- Notebook-specific consumers inspect the current URI before treating it as a
  notebook URI.

This lets a diff tab become a first-class tab without making
`NotebookDataController` understand diffs.

## Problem

Issue #220 calls out that the main workspace tab system is still
notebook-centric:

- `Actions.tsx` builds the Radix tab strip from
  `NotebookContext.useNotebookList()`.
- `CurrentDocContext` stores one URI and many call sites assume that URI is a
  notebook URI.
- `NotebookTabContent` is the only normal tab content renderer.
- `DRIVE_LINK_STATUS_TAB_URI` is a one-off non-notebook tab special case.
- App Console and code mode resolve the current notebook from `currentDoc` or
  visible notebook DOM.

The current checkout reflects the post-#216 state:

- `NotebookDataController` owns `openNotebooks` and loaded `NotebookData`
  handles.
- `NotebookContext` is a React adapter over the controller.
- `CurrentDocContext` persists a selected URI.
- `Actions.tsx` still merges one status-tab special case with
  `openNotebooks.map(...)`.

That is enough for notebook tabs, but it does not scale to notebook diffs or
future views. If `currentDoc` becomes a diff id, notebook runtime helpers will
fail or mutate the wrong state.

## Background

### NotebookDataController

`NotebookDataController` is the current owner of notebook data and notebook-open
state.

File:

- `app/src/lib/notebookDataController.ts`

It owns two related but different concepts:

- loaded `NotebookData` handles, keyed by stable local notebook URI
- `openNotebooks`, the notebook tab metadata list currently used by the UI

Its snapshot is notebook-specific:

```ts
interface NotebookDataControllerSnapshot {
  openNotebooks: OpenNotebookEntry[];
}

interface OpenNotebookEntry {
  uri: string;
  requestedUri: string;
  name: string;
  state: NotebookTabState;
  errorMessage?: string;
}
```

`openNotebook(uri)` resolves or reserves a stable local notebook URI, creates or
loads the `NotebookData` model, and upserts an `OpenNotebookEntry`.

`closeNotebook(localUri)` removes the open entry, disposes the loaded
`NotebookData` handle, and returns a fallback notebook URI.

The controller also persists the open notebook list as restore state.

### NotebookContext

`NotebookContext` is currently a React adapter over `NotebookDataController`.

File:

- `app/src/contexts/NotebookContext.tsx`

It exposes:

```ts
type NotebookContextValue = {
  getNotebookData: (uri: string) => NotebookData | undefined;
  openNotebook: (
    uri: string,
    options?: { name?: string },
  ) => Promise<OpenNotebookResult>;
  useNotebookSnapshot: (uri: string) => NotebookSnapshot | null;
  useNotebookList: () => OpenNotebookEntry[];
  removeNotebook: (uri: string) => string | null;
};
```

The important method for issue #220 is `useNotebookList()`. It subscribes to the
controller snapshot and returns `controller.getSnapshot().openNotebooks`.

Today that list is the source for notebook tabs:

```text
NotebookDataController.openNotebooks
  -> NotebookContext.useNotebookList()
  -> Actions.tsx openNotebooks.map(...)
  -> Radix Tabs.Trigger + NotebookTabContent
```

It also drives the Open Notebooks side panel, App Console notebook listing, and
code-mode notebook listing.

That means notebook model state and workspace tab state are still coupled
through one notebook-specific list. The session refactor moved the list into a
controller, but the list is still named and shaped as open notebooks.

### CurrentDocContext

`CurrentDocContext` is the current selected-URI context.

File:

- `app/src/contexts/CurrentDocContext.tsx`

It exposes:

```ts
getCurrentDoc(): string | null;
setCurrentDoc(uri: string | null): void;
```

It stores the selected URI in React state and persists it as restore state.

Today most callers treat that URI as a notebook URI. `NotebookProvider` also has
compatibility restore logic that opens the stored `currentDoc` as a notebook
when there are no open notebooks.

For the URI-centered workspace model, the context shape is still useful. The
contract changes from "selected notebook URI" to "selected document URI." That
document URI may be a notebook URI, a diff URI, or a status URI.

Notebook-specific callers should inspect the URI scheme before treating
`getCurrentDoc()` as a notebook.

### Current Tab Rendering

`Actions.tsx` currently renders the main tab strip from notebook state.

File:

- `app/src/components/Actions/Actions.tsx`

The normal tabs are produced from:

```ts
const { useNotebookList, removeNotebook } = useNotebookContext();
const openNotebooks = useNotebookList();
```

Then `Actions.tsx` maps `openNotebooks` into `Tabs.Trigger` and
`NotebookTabContent`.

The Drive link status tab is a separate special case keyed by
`DRIVE_LINK_STATUS_TAB_URI`. It proves the tab strip can render a non-notebook
view, but it is not part of a general document model.

Issue #220 is the next step: replace the notebook-specific tab list with an
open document URI list while leaving notebook data ownership in
`NotebookDataController`.

## Goals

- Render notebook diff views as first-class tabs in the existing main workspace.
- Keep notebook state, scroll state, editor state, and mounted DOM behavior at
  least as stable as the current tab system.
- Keep notebook data ownership in `NotebookDataController`.
- Make App Console, code mode, and AppKernel helpers handle non-notebook current
  document URIs without trying to load or mutate them as notebooks.
- Remove the need for more one-off tab branches in `Actions.tsx`.
- Replace the Open Notebooks side panel with an Open Documents panel that has a
  one-to-one mapping with workspace tabs.

## Non-Goals

- Implementing notebook diff rendering itself.
- Adding multi-tab browser ownership for notebooks.
- Migrating legacy `localStorage` restore keys. Assume open/current restore
  state is already tab-local `sessionStorage` state when this design is
  implemented.
- Moving notebook content persistence, autosave, or upstream sync out of
  `NotebookDataController` / `NotebookData`.
- Adding new diff routes or making every route a workspace document.
- Turning notebook diffs into editable notebooks.

## Consistency Review

This proposal is consistent with the prior session and model/view refactors,
but it changes which controller owns the open tab list.

`20260520_notebook_session_refactor.md` split notebook opening/loading from
selection. It made `NotebookDataController.openNotebook(...)` the explicit
model-open path and kept `CurrentDocContext` as selection state. This design
keeps that split and extends the selected value from "visible notebook URI" to
"visible workspace document URI."

`20260520_multi_tab_support.md` moved current/open restore state from shared
`localStorage` to tab-local `sessionStorage`. This design keeps that storage
policy. Workspace documents are tab-local UI state, so the generic open document
list should also persist through `sessionStorage`.

`20260426_getAllRendersRefbug.md` reinforced that notebook mutations update the
model and views subscribe to model snapshots. This design follows the same
direction: `WorkspaceDocumentController` owns tab/view metadata, while
document-specific data owners such as `NotebookDataController` and
`NotebookDiffData` own mutable document state.

The deliberate change from the earlier notebook session design is that
`NotebookDataController.openNotebooks` stops being the long-term UI tab source.
That earlier list was useful when every tab was a notebook. Issue #220 requires
diff and status documents in the same tab strip, so the open tab list moves to a
generic workspace document controller.

## Current Code Audit

The current checkout still has these notebook-centric paths:

- `app/src/components/Actions/Actions.tsx` reads
  `useNotebookContext().useNotebookList()` and maps `openNotebooks` into Radix
  tabs. `DRIVE_LINK_STATUS_TAB_URI` is a separate branch.
- `app/src/components/SidePanel/SidePanel.tsx` renders `OpenNotebooksPanel`
  from `useNotebookList()` and calls `removeNotebook(...)` to close rows.
- `app/src/components/AppConsole/AppConsole.tsx` reads `getCurrentDoc()`,
  `getNotebookData(...)`, and `useNotebookList()` to resolve implicit notebook
  targets and list notebooks.
- `app/src/lib/runtime/useCodeModeExecutor.ts` adds `currentDoc` to its
  notebook URI candidates before resolving notebook data.
- `app/src/components/CurrentDocInitializer.tsx` treats `?doc=` as a notebook
  open command and calls `openNotebook(...)` before `setCurrentDoc(...)`.
- `app/src/contexts/NotebookContext.tsx` still has compatibility logic that can
  reopen the stored `currentDoc` as a notebook when the open notebook list is
  empty.
- `app/src/contexts/CurrentDocContext.tsx` stores the selected URI behind the
  existing `getCurrentDoc()` / `setCurrentDoc(...)` API.

The design addresses those paths directly:

- move `Actions.tsx` and the side panel to `WorkspaceDocument[]`
- keep `CurrentDocContext` and its API name
- remove `useNotebookList()` from the long-term `NotebookContext` API
- make App Console, code mode, and AppKernel notebook helpers check the current
  URI scheme before treating it as a notebook
- keep `?doc=` as a notebook open command and add a diff open command that
  creates or resolves a `diff://...` URI

## Prior Art: VS Code

VS Code separates editor inputs, editor panes, and document models.

Relevant sources:

- https://code.visualstudio.com/api/extension-guides/custom-editors
- https://code.visualstudio.com/api/extension-guides/virtual-documents
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/common/editor/editorInput.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/common/editor.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/editor/common/editorService.ts

VS Code custom editors have a view and a document model. The official docs say a
custom editor has the view users interact with and the document model used to
understand the underlying resource. They also state that one resource has one
document model but can have multiple editor instances.

That maps cleanly to this proposal:

```text
VS Code resource URI       -> Workspace document URI
VS Code editor input       -> WorkspaceDocument tab entry
VS Code editor pane/webview -> Workspace document view
VS Code document model     -> NotebookData / NotebookDiffData / status data
```

VS Code also treats virtual documents as URI-scheme driven. A
`TextDocumentContentProvider` claims a URI scheme, and commands that operate on
those documents check the active document's scheme before acting. That supports
the proposal's rule that notebook-only helpers should no-op when the current
URI is `diff://...` or `status://...`.

One VS Code distinction matters for future extensibility: custom editors use a
`viewType` in addition to the resource URI. The `viewType` decides which editor
implementation renders a matching resource, and users may reopen the same
resource with another editor when multiple editors match.

For Runme v1, the URI scheme is enough because each planned document kind has a
single default view:

- `local://file/<id>` -> notebook editor
- `diff://notebook/<diffId>` -> notebook diff view
- `status://drive-link` -> Drive status view

Do not add a separate `viewType` field yet. Add it later only if the same
document URI needs multiple user-selectable renderings, such as editing and
previewing the same notebook URI in different tab views. Until then, a URI plus
scheme-based switch is simpler and matches the current product need.

## Design

### End State

The end state has three separate layers:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Current selection | `CurrentDocContext` | The selected document URI |
| Workspace tabs | `WorkspaceDocumentController` | Which document URIs are open, tab order, tab titles, close behavior, fallback selection |
| View rendering | `Actions.tsx` plus document view components | Resolve a document URI to the view that renders it |
| Document data | Document-specific data owners | Resolve a document URI to the model/data needed by its view |

The tab controller stores document URIs and tab metadata. It does not own the
underlying data for every document type.

```text
document URI
  -> URI scheme helper
  -> Actions.tsx switch
  -> data owner for that URI scheme
```

Concrete examples:

| URI | Tab metadata | View component | Data owner |
| --- | --- | --- | --- |
| `local://file/<id>` | URI, title | `NotebookTabContent` | `NotebookDataController` / `NotebookData` |
| `diff://notebook/<diffId>` | URI, title | `NotebookDiffTabContent` | `NotebookDiffData` |
| `status://drive-link` | URI, title | `DriveLinkStatusTab` | `driveLinkCoordinator` |

This keeps the system extensible. Adding a new document type means adding:

1. a URI scheme or URI pattern for the document
2. an opener method or command that creates/selects that URI
3. a rendering branch in `Actions.tsx`
4. a document data owner if the view needs live data
5. tests for selection, close behavior, and URI-type handling

The workspace layer should not grow notebook-specific behavior. Notebook-only
features remain behind URI classification helpers such as `isNotebookUri(uri)`
or inside notebook view/data code.

There is one selected document URI:

- current document URI: the selected tab URI, which can point to a notebook,
  diff, or status view

Runtime helpers that only work for notebooks should inspect the URI before
acting. If the current URI is not a notebook URI, they should return `null`,
return an empty result, or no-op according to their existing contract.

### WorkspaceDocument

Add a generic tab/document model outside `NotebookDataController`. Use the URI
as the durable identity and selection key.

```ts
interface WorkspaceDocument {
  uri: string;
  title: string;
}
```

`uri` is the tab identity used by Radix `Tabs`. It must be stable and unique:

- notebook: `local://file/<id>`
- notebook diff: `diff://notebook/<diffId>`
- Drive status: `status://drive-link`

Document-specific metadata should live in the document data layer, not in the
tab entry, unless it is needed for tab presentation. For example, a diff
document can store its base/head notebook URIs in a `NotebookDiffData` record
keyed by `diff://notebook/<diffId>`.

Use helpers to classify URIs:

```ts
function getWorkspaceDocumentScheme(uri: string): string;
function isNotebookDocumentUri(uri: string): boolean;
function isNotebookDiffUri(uri: string): boolean;
function isStatusUri(uri: string): boolean;
```

For notebooks, `local://file/<id>` remains the canonical editable notebook URI.
For diffs, use a real URI rather than a secondary id:

```text
diff://notebook/<diffId>
```

If a diff needs embedded context, prefer storing it in the diff data model keyed
by the diff URI. If the diff is cheap and stateless, query parameters are also
acceptable:

```text
diff://notebook/<diffId>?base=local%3A%2F%2Ffile%2Fbase&head=local%3A%2F%2Ffile%2Fhead
```

### URI Classification And Rendering

Use simple URI classification helpers and a switch in `Actions.tsx` to connect
workspace document URIs to views.

The current product needs only three document kinds, and centralizing the
rendering decision in the tab component is easier to review.

Suggested rendering shape:

```tsx
function renderWorkspaceDocument(document: WorkspaceDocument) {
  if (isNotebookDocumentUri(document.uri)) {
    return <NotebookTabContent docUri={document.uri} />;
  }

  if (isNotebookDiffUri(document.uri)) {
    return <NotebookDiffTabContent diffUri={document.uri} />;
  }

  if (document.uri === "status://drive-link") {
    return <DriveLinkStatusTab ... />;
  }

  return <UnknownDocumentTab uri={document.uri} />;
}
```

Each view resolves its own document data through the owner for that URI scheme:

- `local://file/<id>` resolves through `NotebookDataController.getNotebookData(uri)`.
- `diff://notebook/<diffId>` resolves through `NotebookDiffData`.
- `status://drive-link` resolves through `driveLinkCoordinator`.

This keeps "document" as the data object and "view" as the renderer. A tab is
only an open URI plus presentation metadata.

Document-specific cleanup is optional. If a document data owner has no cleanup
work, closing the workspace document only removes the URI from the open document
list.

### NotebookDiffData

Use a small `NotebookDiffData` model as the data owner for
`diff://notebook/<diffId>` documents.

Responsibilities:

- store the diff URI
- store the base/head notebook URIs or enough metadata to resolve them
- load or compute the diff payload needed by `NotebookDiffTabContent`
- expose a snapshot/subscribe API if diff data can load asynchronously or change
- optionally clean up in-memory diff state when the workspace document closes

Suggested shape:

```ts
interface NotebookDiffSnapshot {
  uri: string;
  title: string;
  baseNotebookUri?: string;
  headNotebookUri?: string;
  state: "loading" | "loaded" | "error";
  errorMessage?: string;
}

class NotebookDiffData {
  getSnapshot(): NotebookDiffSnapshot;
  subscribe(listener: () => void): () => void;
  close(): void;
}
```

Add a small diff data controller only if the first implementation needs multiple
diff documents tracked by URI:

```ts
getNotebookDiffData(uri: string): NotebookDiffData | undefined;
openNotebookDiff(uri: string, options: NotebookDiffOpenOptions): NotebookDiffData;
closeNotebookDiff(uri: string): void;
```

Do not put diff data into `WorkspaceDocumentController`. The workspace
controller owns the open URI list; `NotebookDiffData` owns the diff document
state.

### WorkspaceDocumentController

Add a vanilla TypeScript singleton:

```text
app/src/lib/workspaceDocuments/workspaceDocumentController.ts
```

Suggested API:

```ts
interface WorkspaceDocumentSnapshot {
  documents: WorkspaceDocument[];
}

class WorkspaceDocumentController {
  getSnapshot(): WorkspaceDocumentSnapshot;
  subscribe(listener: () => void): () => void;

  showDocument(uri: string, options?: {
    title?: string;
  }): void;

  closeDocument(uri: string): string | null;
}
```

The controller owns:

- visible workspace documents
- close behavior that removes a URI from the open document list and returns a
  fallback URI
- generic tab persistence adapter

It does not own:

- `NotebookData`
- notebook loading
- notebook save/sync state
- diff data loading
- Drive link auth state

### Notebook Opening And Showing

Opening and showing a notebook remains three explicit operations:

```ts
const result = await notebookDataController.openNotebook(uri, { name });
workspaceDocumentController.showDocument(result.localUri, {
  title: result.entry.name,
});
setCurrentDoc(result.localUri);
```

This preserves the session refactor:

- `NotebookDataController.openNotebook(...)` resolves or reserves the stable
  local URI, creates/loads `NotebookData`, and returns load state.
- `WorkspaceDocumentController.showDocument(...)` adds or updates the visible
  workspace document entry for the notebook URI.
- `setCurrentDoc(result.localUri)` selects the notebook tab.

Do not make `WorkspaceDocumentController` call storage directly. Storage and
notebook model lifecycle stay behind `NotebookDataController`.

The workspace controller should not have document-type-specific show methods.
It should derive defaults from the URI scheme:

```ts
showDocument("local://file/abc", { title: "notes.md" });
showDocument("diff://notebook/123", { title: "Notebook diff" });
showDocument("status://drive-link", { title: "Drive Link Status" });
```

Document-specific open flows can still exist outside the controller when they
need to prepare data before showing the URI. For example, a notebook open flow
must call `NotebookDataController.openNotebook(...)` before showing the
workspace document URI. A future diff open flow may create a diff data record
before showing `diff://notebook/<diffId>`.

### Slimmed NotebookContext

Keep `NotebookContext`, but narrow it to notebook data access. It should stop
being the source of truth for open tabs.

Target shape:

```ts
type NotebookContextValue = {
  getNotebookData: (uri: string) => NotebookData | undefined;
  openNotebook: (
    uri: string,
    options?: { name?: string },
  ) => Promise<OpenNotebookResult>;
  useNotebookSnapshot: (uri: string) => NotebookSnapshot | null;
};
```

Remove these responsibilities from `NotebookContext`:

- `useNotebookList()`
- tab list persistence
- tab close/fallback selection
- any non-notebook document awareness

Those move to the workspace document layer:

```text
WorkspaceDocumentController.documents
  -> WorkspaceDocumentContext.useWorkspaceDocuments()
  -> Actions tabs / Open Documents panel
```

`NotebookContext.openNotebook(...)` still prepares notebook data. It should not
also imply the notebook is visible or selected. Callers that want to show the
notebook should do all three operations explicitly:

```ts
const result = await openNotebook(uri, { name });
showDocument(result.localUri, { title: result.entry.name });
setCurrentDoc(result.localUri);
```

`removeNotebook(...)` can remain as a temporary compatibility wrapper during
migration, but it should not be the long-term tab-close API. The long-term close
path is `closeWorkspaceDocument(uri)`, with optional notebook cleanup when
`isNotebookDocumentUri(uri)`.

### CurrentDocContext

Keep `CurrentDocContext` as the selected workspace document URI.

The type already matches the URI-centered model:

```ts
currentDoc: string | null;
setCurrentDoc(uri: string | null): void;
```

The semantic change is that `currentDoc` can be any workspace document URI:

- selecting a notebook tab sets `currentDoc` to `local://file/<id>`
- selecting a diff tab sets `currentDoc` to `diff://notebook/<diffId>`
- selecting the Drive status tab sets `currentDoc` to `status://drive-link`
- closing the active document sets `currentDoc` to the fallback open document
  URI or `null`

The restore backend should be tab-local `sessionStorage`. The selected document
is tab-local UI state, just like the open document list.

Keep the name `CurrentDocContext` for this refactor. The important change is the
contract: the value is a workspace document URI, not necessarily a notebook URI.

Add a separate context only for open document state:

```text
app/src/contexts/WorkspaceDocumentContext.tsx
```

It should expose the open documents and show/close helpers, but not duplicate
current selection:

```ts
type WorkspaceDocumentContextValue = {
  useWorkspaceDocuments: () => WorkspaceDocument[];
  showDocument: (uri: string, options?: { title?: string }) => void;
  closeWorkspaceDocument: (uri: string) => string | null;
};
```

### Actions Rendering

`Actions.tsx` should render tabs from `WorkspaceDocument[]`, not from
`openNotebooks` plus status special cases.

Rendering becomes a URI-scheme switch:

```tsx
if (isNotebookDocumentUri(document.uri)) {
  return <NotebookTabContent docUri={document.uri} />;
}

if (isNotebookDiffUri(document.uri)) {
  return <NotebookDiffTabContent diffUri={document.uri} />;
}

if (document.uri === "status://drive-link") {
  return <DriveLinkStatusTab ... />;
}

return <UnknownDocumentTab uri={document.uri} />;
```

Notebook-only affordances stay behind the type guard:

- sync indicator
- notebook context menu
- copy shareable link
- close notebook via `NotebookDataController.closeNotebook`
- active-cell persistence keyed by notebook URI

Diff tabs get their own close and context actions. They must not render notebook
sync state or appear in `NotebookDataController.getOpenNotebooks()`.

All workspace documents are closeable from the workspace perspective. Closing a
document removes its URI from the open document list and returns the next
fallback URI. Document-specific cleanup should be optional and no-op by default.
For example, a notebook close handler may also call
`NotebookDataController.closeNotebook(uri)`, while closing a status document may
only remove `status://drive-link` from the open document list.

`TabPanel` with `forceMount` should remain the tab-content wrapper. It already
preserves DOM state for inactive tabs. Diff tabs should use the same wrapper so
switching between notebook and diff tabs has the same mounted-state behavior as
switching between notebook tabs.

### Drive Link Status

Migrate the Drive link status tab into the generic document model after the
notebook/diff path exists.

`driveLinkCoordinator` should open or close the status document based on its
snapshot:

- when intents or errors exist: show `status://drive-link` with
  `showDocument(...)`
- when no intents or errors remain: close `status://drive-link`

This removes `DRIVE_LINK_STATUS_TAB_URI` from `Actions.tsx`. If the first
implementation slice keeps the status tab as a temporary special case, that
should be documented as a transition step and not copied for diff tabs.

### App Console And Code Mode

Notebook runtime helpers can continue to start from `CurrentDocContext`.

Rules:

- If `getCurrentDoc()` returns a notebook URI, resolve the notebook data and
  operate on it.
- If `getCurrentDoc()` returns a diff or status URI, notebook-only helpers
  should return `null`, return an empty result, or no-op according to their
  existing contract.
- Explicit notebook targets still win over implicit `CurrentDocContext` state.

Update these consumers to validate the current URI before treating it as a
notebook:

- `AppConsole.tsx`
- `useCodeModeExecutor.ts`
- AppKernel notebook helpers
- any future WebMCP notebook mutation entrypoints

This is the acceptance-criteria guardrail: non-notebook tabs can be active
without notebook-only code trying to load or mutate `diff://...` as a notebook.

### Open Documents Side Panel

Replace the Open Notebooks side panel with Open Documents.

The panel should read from the same `WorkspaceDocumentController.documents`
snapshot as the tab strip. There should be a one-to-one mapping between open
workspace documents and rows in the panel:

- notebook tabs appear as notebook rows
- diff tabs appear as diff rows
- status tabs appear as status rows, if they are represented as workspace
  documents

The panel should not read from `NotebookDataController.getOpenNotebooks()`.
Notebook-specific metadata, such as sync state, can be rendered only for
notebook URI rows.

### URL And Open Commands

Treat URL/query parameters as commands that prepare and show workspace
documents only where URL handling already exists.

Existing notebook `?doc=` handling should continue to call:

```ts
openNotebook(...)
showDocument(...)
setCurrentDoc(...)
```

Do not add a `/diff/:diffId` route for the initial implementation. Diff
entrypoints should create or resolve a diff URI and show it in the existing
workspace:

```text
create or resolve diff URI: diff://notebook/<diffId>
showDocument(diffUri)
setCurrentDoc(diffUri)
```

Diff documents are ephemeral in the initial design. A diff entrypoint may create
a `diff://...` workspace document for the current tab, but reload should not
restore that diff tab.

### Persistence

Persist open workspace document state through a small storage adapter. The
adapter should use `sessionStorage` for the new workspace document state.

```ts
interface WorkspaceDocumentPersistence {
  loadDocuments(): WorkspaceDocument[];
  saveDocuments(documents: WorkspaceDocument[]): void;
}
```

Do not hard-code `sessionStorage` calls throughout
`WorkspaceDocumentController`. The adapter is intentionally small, but it keeps
storage policy separate from open-document behavior:

- the controller can be tested with an in-memory persistence backend
- browser storage failures can be isolated from controller logic
- the multi-tab storage decision is explicit instead of hidden in controller
  methods

The target storage split is:

| State | Storage |
| --- | --- |
| restorable open workspace documents | `sessionStorage` |
| current selected document URI, when restorable | `sessionStorage` |

Use `sessionStorage` because open workspace documents are tab-local UI state. Two
browser tabs should be able to show different open document sets. Shared
`localStorage` would make same-origin tabs converge on the same open document
list, which is the multi-tab bug this design should avoid.

Not every open document has to be restorable. For the initial implementation,
persist only notebook workspace documents. Do not persist `diff://...` entries.
If the current document is a diff when the tab is closed or reloaded, restore to
the next restorable document or `null`.

Do not use shared `localStorage` as the authoritative store for open workspace
documents or current document selection.

Once `Actions`, App Console, code mode, and the side panel use the workspace
document APIs, the workspace persistence can become the only open-tab restore
store.

## Implementation Slicing

These slices do not have to be five separate PRs. Split by reviewability and
rollback risk, not by this document's headings.

Reasonable options:

- one PR for the controller/context plus tab rendering if the diff view is small
  and tests stay focused
- two PRs where the first adds the generic tab model and the second moves
  `Actions.tsx` plus diff tabs onto it
- more PRs if App Console, code mode, URL initialization, and Drive status migration
  would make the main tab-rendering PR hard to review

The invariant is that every merged PR should leave one clear tab source of truth
for the surfaces it migrates. Avoid a long-lived state where `Actions.tsx`,
App Console, and the side panel each infer active/open documents differently.

### Slice 1: Add Generic Workspace Documents

- Add `WorkspaceDocumentController`.
- Add `WorkspaceDocumentContext`.
- Seed notebook workspace documents from the existing
  `NotebookDataController.openNotebooks` snapshot.
- Keep `CurrentDocContext` as selected document URI state.
- Add tests for open/select/close behavior across notebook, diff, and status
  documents.

This slice should not change visible behavior.

### Slice 2: Move The Main Tab Strip

- Update `Actions.tsx` to render `WorkspaceDocument[]`.
- Keep `NotebookTabContent` unchanged.
- Add `NotebookDiffTabContent` as the renderer for diff documents.
- Preserve `TabPanel` + `forceMount` behavior for all document URI schemes.
- Keep notebook-only tab affordances behind `isNotebookDocumentUri(document.uri)`.

This slice satisfies the core issue requirement: diff views can render as tabs next
to notebooks.

### Slice 3: Migrate Open Callers

- Workspace Explorer: `openNotebook` then `showDocument`.
- URL initializer: treat `?doc=` as a notebook open command.
- App Console `app.openNotebook(...)`: open the notebook data model, show the
  workspace document, then select the workspace document.
- Drive link coordinator: show successful notebook URIs with `showDocument`,
  then select them with `setCurrentDoc`.
- Diff entrypoints: create or resolve a `diff://...` URI, then call
  `showDocument(diffUri)`.

After this slice, callers should use `setCurrentDoc(...)` for selected document
URIs, not as an implicit notebook-open command.

### Slice 4: Fix Notebook Runtime Resolution

- Move App Console and code mode onto URI-scheme checks before notebook work.
- Keep explicit notebook target resolution unchanged.
- Add tests where a diff tab is active and notebook-only helpers no-op or return
  `null`.

### Slice 5: Remove Transitional Duplication

- Stop treating `NotebookDataController.openNotebooks` as the tab-strip source
  of truth.
- Keep notebook data handles and load state in `NotebookDataController`.
- Keep notebook tab metadata in `WorkspaceDocumentController`.
- Remove `useNotebookList()` from the long-term `NotebookContext` API.
- Either migrate Drive Link Status to `WorkspaceDocumentController` or leave it
  as an explicitly documented temporary exception.

## Testing

Unit tests:

- `WorkspaceDocumentController` shows, deduplicates, selects, closes, and
  returns fallback URIs for each document URI scheme.
- Selecting a diff/status document updates the current document URI.
- Selecting a notebook document updates the current document URI.
- Closing the active document chooses the next open document URI.

React tests:

- `Actions` renders notebook and diff tabs from the same tab list.
- Switching notebook -> diff -> notebook keeps notebook content mounted.
- Diff tabs do not render notebook sync indicators or notebook context-menu
  actions.
- Diff tabs are not restored from `sessionStorage` after reload.
- Open Documents side panel has one row per workspace tab, including diffs.
- App Console does not treat a `diff://...` current document as a notebook.

Manual checks:

- Open two notebooks, switch between them, confirm editor and scroll state
  remain stable.
- Open a diff tab next to notebooks, switch back and forth, confirm notebook
  state remains stable.
- Close a diff tab and confirm notebook selection is unchanged.
- Close the active document while a diff tab exists and confirm the current
  document URI falls back to the next open document.

## Risks

The main risk is creating two competing sources of truth during migration:
`NotebookDataController.openNotebooks` and `WorkspaceDocumentController`.
Mitigate this by making the migration direction explicit:

- notebook data ownership remains in `NotebookDataController`
- tab ownership moves to `WorkspaceDocumentController`
- temporary adapters should be deleted after call sites move

The second risk is changing App Console behavior subtly. Avoid that by making
notebook-only helpers check the current URI scheme before resolving notebook
data.

## Open Questions

None.
