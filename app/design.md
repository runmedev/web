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

## Global State and Singletons

When should we rely on global singletons and storing state outside of React versus using React contexts?

I think using global singletons makes more sense when
* We want to access the data in library code that is independent of React
* The UI isn't reactive to changes in the state

Example would be things like clients for talking to backend services (e.g. runme)
* We can have a singleton ClientManager which provides methods for getting/setting the clients
* Libraries that need a client can then get it via the ClientManager
* When user changes a setting in the UI (E.g. backend URL) we can react and update the clients in the ClientManager

## Unresolved Design Questions

### Snapshot ownershop?

Who should own snapshots of data? Should NotebookData own snapshots of cells or should each CellData own
its own snapshot?

Should we keep track of a "version" and bump it when the data changes and indicating a new snapshot is available?

### Emitting events 

How should CellData and NotebookData emit events in order to efficiently signal re-rendering? 

One option would be to use a bitmask to indicate different types of changes; e.g. runner changed, cell type changed, cell language changed etc...
Different REACT components could then filter out for their events and only rerender when necessary
