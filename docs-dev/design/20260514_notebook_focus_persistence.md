# Notebook Focus Persistence

## Scope

This document proposes a simpler model for restoring notebook cell focus across:

- switching away from the browser tab and back
- switching between notebook tabs in the app
- refreshing the page

The target behavior is:

1. Each open notebook remembers its last active cell.
2. Markdown cells remember whether the last active surface was the editor or the
   rendered view.
3. Returning to the browser tab restores focus to the visible notebook's last
   active cell.
4. Refreshing the page restores the same cell and reopens markdown in edit mode
   when the editor was last active.

## Current Problem

The current implementation models focus restore as a React event counter.

That creates two problems:

- it mixes durable UI state with transient focus events
- it lets unrelated re-renders replay restore logic

The reviewer concern is valid. If restore is encoded as `restoreFocusRequest`,
the code must answer "has this request already been consumed?" in every effect
that reads it. That makes markdown edit/render behavior fragile.

## Decision

We will persist per-notebook active-cell UI state in `localStorage`.

We will not persist focus-restore event counters.

We will track window/tab focus separately as transient React state and use it
only to decide when to apply the already-persisted active-cell state.

## Why `localStorage`

`localStorage` is the right default here because:

- the state is tiny
- it is JSON-shaped
- it must be readable during initial render
- it should survive refresh
- it does not need IndexedDB queries or transactions

IndexedDB remains the right place for notebook content and mirrored storage.
This feature is UI state, not notebook data.

## Stored Shape

Suggested payload:

```ts
type CellFocusRole = "editor" | "rendered";

interface NotebookActiveCellState {
  refId: string;
  focusRole: CellFocusRole;
  updatedAt: string;
}

type NotebookActiveCellMap = Record<string, NotebookActiveCellState>;
```

Storage key:

```ts
const STORAGE_KEY = "runme/notebook-active-cells";
```

The map is keyed by notebook URI.

## Behavior

### On cell focus

When focus moves within a notebook cell:

- record the notebook URI
- record the cell ref id
- record whether focus is in the editor or rendered markdown surface
- persist the map to `localStorage`

### On browser focus return

When the browser tab becomes focused and visible:

- look at the visible notebook tab, not `currentDoc`
- read that notebook's stored active-cell state
- if the stored cell still exists, restore focus to it
- if the stored focus role is `editor` for a markdown cell, reopen that cell in
  edit mode before focusing it
- if the visible tab is a non-notebook synthetic tab, do nothing

### On page refresh

During initial render of a notebook tab:

- read stored active-cell state for that notebook
- if the active cell is a markdown cell and the stored role is `editor`, mount
  that cell in edit mode
- if the page is already focused, place focus back into that cell

### On stale state

If the stored cell no longer exists:

- ignore the stored entry
- fall back to normal rendering

We do not need aggressive cleanup when notebooks close. Keeping the last active
cell for a notebook is useful if the user reopens it later.

## Implementation Plan

1. Add a small helper module for reading and writing the persisted map.
2. Load persisted active-cell state in `Actions`.
3. Replace restore counters with:
   - durable active-cell state from storage
   - transient `window focused` state
4. Change `MarkdownCell` to derive initial edit mode from persisted active-cell
   state instead of replaying a request counter.
5. Add focused unit tests for:
   - storage normalization
   - markdown initial edit-mode restore
   - focus restore on browser refocus without replaying on every keystroke
6. Verify behavior in a browser scenario and record a video artifact.

## Tradeoffs

- `localStorage` is synchronous. That is acceptable because the payload is tiny
  and the feature is startup-sensitive.
- The stored state is browser-local. That is correct for per-browser UI focus.
- We still keep a small amount of React state for "is the browser focused?".
  That state is transient and does not encode restore events, which keeps the
  model simpler than a counter.

## Recommendation

Persist `{ docUri -> activeCellId, focusRole }` in `localStorage` and treat
window focus as a transient signal that reapplies that durable state to the
visible notebook only.
