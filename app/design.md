# runme Web Design

## Overview

Some notes about the overall design of the runme web app.

## Model - View Architecture

We have adopted a model view architecture for the app. 
NotebookData and CellData are the models storing the data.
To interact with REACT we use `useSyncExternalStore` and subscribe to events.

Motivation here is that the underlying protos provide complex data structures
and we want to use them to hold the application data. We don't want to
destructure those protos into individual fields stored on REACT components
in order to make the REACT components properly render.

We want NotebookData and CellData to emit events which REACT components
can subscribe to and then rerender when the data has changed.

For rendering, codex suggested we should still produce snapshots of the data
because REACT 18 and newer supports concurrent rendering which can lead to
tearing if we don't have snapshots.

### Notebook Session State

`NotebookDataController` owns the notebook session state outside React.

It is responsible for:

* resolving requested notebook URIs to stable `local://file/...` URIs
* tracking the open notebook list
* owning loaded `NotebookData` instances
* loading notebook content through `LocalNotebooks`
* exposing snapshots and subscriptions for React adapters

`NotebookContext` is a React adapter over `NotebookDataController`. It should
not own the `NotebookData` registry itself.

`CurrentDocContext` owns only the visible notebook selection. Setting the
current doc should not load, mirror, or create notebook data. Callers that want
to open a notebook should first call `openNotebook(uri)` and then select the
returned local URI.

The intended flow is:

```text
openNotebook(uri)
  -> resolve or reserve stable local URI
  -> create/load NotebookData when possible
  -> return local URI plus load state
setCurrentDoc(localUri)
  -> update visible selection only
```

## Global State and Singletons

When should we rely on global singletons and storing state outside of React versus using React contexts?

I think using global singletons makes more sense when
* We want to access the data in library code that is independent of React
* The UI reads the state through a subscription/snapshot adapter rather than
  owning the state directly
* The object coordinates business logic that should not be tied to React mount
  order

Example would be things like clients for talking to backend services (e.g. runme)
* We can have a singleton ClientManager which provides methods for getting/setting the clients
* Libraries that need a client can then get it via the ClientManager
* When user changes a setting in the UI (E.g. backend URL) we can react and update the clients in the ClientManager

`NotebookDataController` follows this pattern. It is a global singleton because
runtime helpers, App Console, notebook views, and future multi-tab ownership
logic all need one notebook session owner. React remains reactive by subscribing
to the controller snapshot through `NotebookContext`.

## Unresolved Design Questions

### Snapshot ownershop?

Who should own snapshots of data? Should NotebookData own snapshots of cells or should each CellData own
its own snapshot?

Should we keep track of a "version" and bump it when the data changes and indicating a new snapshot is available?

### Emitting events 

How should CellData and NotebookData emit events in order to efficiently signal re-rendering? 

One option would be to use a bitmask to indicate different types of changes; e.g. runner changed, cell type changed, cell language changed etc...
Different REACT components could then filter out for their events and only rerender when necessary
