# Notebook Cell Deep Links

Author: Jeremy Lewi

Date: 2026-07-18

Status: Draft

## TL;DR

Runme will link to a cell in an editable notebook with the notebook URI and the
cell's stable `Cell.refId`:

```text
https://runme.example/?doc=<notebook-uri>#cell=<percent-encoded-ref-id>
```

Each cell will expose a link button and a context-menu action. Opening the link
will select the notebook, scroll the cell into view, and highlight it without
focusing the editor.

## Motivation

Whole-notebook links do not identify the cell under discussion. A user sharing
a debugging step, result, or instruction must describe where to look, and the
recipient must search for it manually.

Cell links should remain valid when nearby cells are inserted, deleted, or
reordered. They should also behave consistently for code, Markdown, and HTML
cells across Drive-backed and local notebooks.

## Background

Whole-notebook share links use the current app path and a `doc` query
parameter:

```text
/?doc=<notebook-uri>
```

The app resolves the notebook URI, opens the notebook, and removes `doc` from
the address bar after consuming it. URL cleanup already preserves the
fragment.

Editable notebook cells use `Cell.refId` for editor state, execution state,
comments, diffs, and focus persistence. Newly created cells receive a
UUID-based `code_...` or `markup_...` ref id. Notebook loading repairs legacy
cells that have no ref id.

The editable notebook UI does not have a reviewed cell URL contract or a
visible cell-link affordance.

## Proposal

### Cell identity

We will use `Cell.refId` as the cell identifier. An ordinal is not stable
because inserting or moving a cell changes what the number refers to. A hash
of cell source is not stable because normal editing changes it.

Cell ref ids are scoped to a notebook. A complete target contains both values:

```ts
type NotebookCellLinkTarget = {
  notebookUri: string
  cellRefId: string
}
```

A linkable cell must have a non-empty ref id that is unique within its
notebook. The app must preserve the ref id when the cell is edited, executed,
moved, or synchronized. Deleting and recreating a cell creates a new identity
and invalidates the old link.

### URL format

The canonical fragment is:

```text
#cell=<percent-encoded-ref-id>
```

Examples:

```text
/?doc=local%3A%2F%2Ffile%2Fabc#cell=code_4f84d960
/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Fabc%2Fview#cell=markup_a81c
```

The fragment represents client-side view state, so it does not change server
routing or notebook lookup. The `cell=` namespace distinguishes cell links
from OAuth responses and future fragment-based state.

The editable notebook will generate and accept only the namespaced form. Bare
fragments and fragments with other keys are ignored. Empty cell values are
invalid.

The implementation will expose these helpers:

```ts
function buildNotebookCellShareUrl(
  notebookUri: string,
  cellRefId: string
): string

function parseNotebookCellFragment(hash: string): string | null
```

### Opening a link

The app will resolve a link in this order:

1. Parse `doc` and `cell` independently.
2. Open and select the notebook through the existing `doc` flow.
3. Wait for the selected notebook snapshot and cell DOM to load.
4. Find an exact `data-cell-ref-id` match inside that notebook tab.
5. Scroll the cell to the center of the notebook viewport.
6. Apply a temporary accent highlight.

Lookup must be scoped to the selected notebook because ref ids are not
globally unique. Fragment and browser-history changes will navigate within an
already-open notebook without reloading it.

Navigation will not focus the editor. Focusing can enter Markdown edit mode or
move a caret, which is an unexpected side effect for navigation.

If the notebook loads but the target does not exist, the app will keep the
notebook open and report:

> The linked cell no longer exists in this notebook.

The app will not fall back to a cell at the same ordinal.

### Copying a link

Each code, Markdown, and HTML cell will have a chain-link button with the
accessible name **Copy link to cell**. The button will appear with the cell's
other actions and remain visible when the cell is hovered, focused, or active.
The existing cell context menu will also contain the action.

Copying will not navigate, change the selected cell, or modify the address bar.
It will show **Link to cell copied** on success. Clipboard failures will show:

> Could not copy the cell link. Check clipboard permissions and try again.

For a Drive-backed local mirror, the link will use the upstream Drive URI.
Recipients still need permission to open the file. Filesystem and browser-local
notebooks will use their local URI; those links work only where that notebook
URI can be resolved. The context menu will label these **Copy local link to
cell**.

Copying a link will never upload a notebook or change its sharing settings.

### Accessibility

- The link control is a native button in the cell's normal tab order.
- Its focus style and visibility do not depend on hover.
- Toasts use the existing polite live region.
- Navigation scrolls and highlights without moving keyboard focus.
- The missing-target message uses the same live region.

### Implementation and validation

Implementation steps:

1. Add canonical fragment build and parse helpers.
2. Add the link button and context-menu action to every editable cell kind.
3. Resolve fragments after the selected notebook renders.
4. Scope lookup to the selected notebook tab.
5. Add success, clipboard-error, and missing-cell feedback.
6. Highlight the target without focusing the editor.

Automated tests will cover URL encoding, unknown fragments, code/Markdown/HTML
affordances, Drive and local links, clipboard errors, notebook-scoped lookup,
missing targets, and history changes.

A browser test will copy a link to an off-screen cell, open it in a fresh tab,
and verify that the correct notebook and cell are visible and highlighted
without editor focus.

No notebook data migration is required.

## Alternatives

| Option                          | Decision                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `#cell=<refId>`                 | Chosen. It is client-only, namespaced, and participates in browser history.                         |
| Bare `#<refId>`                 | Rejected. It collides with OAuth and future fragment state.                                         |
| `?doc=<uri>&cell=<refId>`       | Rejected. It mixes document identity with transient view state and sends the cell id to the server. |
| `/notebooks/<id>/cells/<refId>` | Rejected. It requires new server routing for client-side view state.                                |
| Cell ordinal                    | Rejected. It breaks after insertion, deletion, or reordering.                                       |
| Hash of cell source             | Rejected. It breaks when source changes and can collide.                                            |
| Context menu only               | Rejected. It is difficult to discover and weak for touch and keyboard users.                        |
| Always-visible text link        | Rejected. It adds substantial repeated chrome to every cell.                                        |

## References

- [Issue #209: Add deep linking and bookmarks](https://github.com/runmedev/web/issues/209)
- [PR #240: Preserve fragments while opening shared notebooks](https://github.com/runmedev/web/pull/240)
- [PR #285: Add notebook cell deep links](https://github.com/runmedev/web/pull/285)
