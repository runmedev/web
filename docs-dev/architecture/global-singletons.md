# Global Singletons

Global singletons are acceptable when they own application logic that must be
available outside React and when React can observe them through explicit
subscriptions.

They should not be hidden mutable state. A singleton that owns user-visible
state should expose:

- command methods for mutations
- `getSnapshot()` for current state
- `subscribe(listener)` for React adapters
- an explicit test reset helper when module state would otherwise leak between
  tests

React contexts should adapt these objects for components. They should not
duplicate the singleton's business state in parallel React state.

## Notebook Session

`NotebookDataController` is the singleton owner for notebook session state.

It owns:

- the open notebook list
- the URI-keyed `NotebookData` registry
- notebook open/close commands
- loading notebook content through `LocalNotebooks`
- persistence of the existing open-notebook restore key

`NotebookContext` adapts `NotebookDataController` into React hooks:

- `useNotebookList()`
- `useNotebookSnapshot(uri)`
- `getNotebookData(uri)`
- `openNotebook(uri)`
- `removeNotebook(uri)`

`CurrentDocContext` is intentionally separate. It owns the selected visible
notebook URI only. It should not create, mirror, or load notebooks.

The expected caller flow is:

```text
await openNotebook(uri)
setCurrentDoc(localUri)
```

Selection-only callers, such as the tab strip or open-notebooks sidebar, should
call only `setCurrentDoc(localUri)` for notebooks that are already open.

## Persistence

Notebook session restore state is stored in per-tab `sessionStorage` keys:

- `runme/currentDoc`
- `runme/openNotebooks`

Keep persistence code isolated so notebook loading and selection semantics do
not depend on the storage backend.
