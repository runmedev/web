---
name: notebook-review-rounds
title: Compare notebook revisions
order: 19
description: Comment on notebook changes immediately, select sections, and assess scoped suggestions.
---

# Compare notebook revisions

Read and comment on a .runme notebook in the editor. Ask your collaborator to
address the comments, edit the same cells, and reply in the existing threads.
Then right-click the notebook tab and choose **Review suggestions**.
The suggestion tab stays beside the editor.

Choose start/end revisions and a scope. That selection defines **one suggestion**.
The diff updates immediately and is immediately commentable: there is no
Start review, draft, or Submit review step. Browsing does not create metadata.
The first comment or assessment records the fixed pair and scope.

Use the chevron beside **Compare changes** to collapse the left panel and give
the diff more room. The remaining chevron expands it again. Your revision and
scope selection and unsent comments are preserved while the panel is hidden.
The independent **Hide comments** / **Show comments** control collapses the right
gutter. A blue cell marker also reopens it. Unsent cell comments and replies stay
intact; either panel can be hidden without hiding the other.

Use **Good Enough** when that suggestion needs no further edits, or
**Needs More Work** and leave feedback. These actions do not undo edits, change
notebook contents, or resolve comments. Select another section to assess it
independently. For the next iteration compare the previous response with the
new response; earlier snapshots and feedback remain unchanged.

## Pick versions and sections

New comparisons default to the latest named revision before the latest revision,
or **Empty notebook** when no such named revision exists. The end defaults to
the latest revision. Existing selections stay fixed when new edits or labels arrive.

Expand **Name a revision** to label a historical snapshot and describe it.
The selector shows its name, description, and last content-change date in your
local time zone. Labels and comments do not change that date.
**Named revisions only** helps select the versions you intended to compare;
the empty baseline stays available. End revisions must strictly extend the
start's changes, not merely have a later timestamp.

Select **Heading / section range** under Suggestion scope. **From heading**
and **Through section** include descendant headings and body cells through the
next equal-or-higher-level heading. The same heading in both selects one section.
Multiple headings in a cell select the whole cell.

**Outline from** chooses the end or start revision; use the start outline for
deleted sections. Scope is a fixed set of cell IDs, not an expanding region.
The API supports noncontiguous sets from either endpoint; each ID must exist in
at least one endpoint. Omit cellIds for the whole document. An explicit set must
be nonempty. Duplicate/reordered IDs identify the same suggestion.

## Shared comments

The left panel contains one suggestion-wide conversation, with no Whole/Cell
target dropdown. Cell and selected-source threads appear in the right gutter
beside their cells, including ordinary comments created in the editor. A blue
bar on the cell's right edge marks attached threads; click it to focus the
gutter. Selected-text comments retain their quote in the thread; precise text
underlining is not yet provided. Return to the
editor to see and reply to those same threads. Replies and resolve/reopen actions
are shared, not copied into a separate discussion per view.

Use the blue comment-bubble icon in the cell's upper-right corner, or right-click
and choose **Comment on cell**. Select source and use **Comment on selection**
in the right-click menu; it is disabled when there is no valid selection.
There are no visible cell-number/status captions or comment-action text rows
between cells. **Comment on previous cell** remains available in the context menu
for modified cells. Removed text anchors to the start
snapshot; added text to the end snapshot. Unchanged text defaults to the end.
Select only one side and one cell at a time. Linked resources support whole-cell
comments, not selection within the resource.

Quotes, original comparison IDs, and optional UTF-16 source ranges remain in
the .runme log. They are not rendered-Markdown offsets. Changed or deleted
context is labeled rather than silently retargeted to today's text. The editor
shows historical quotes without claiming an exact current source selection.
Whole-suggestion feedback belongs to its original pair/scope; cell feedback
remains visible in other comparisons containing that cell.

## Accept or undo a cell's changes

Type directly into the comment box in each change card; no extra click is
needed to open a composer. Enter sends comments and replies; Shift+Enter adds
a newline. Drafts survive hiding the gutter or a failed send.

Each changed cell has checkmark and X controls in its right-hand discussion
gutter. **Accept** keeps the content and stops showing that cell's diff. The
decision follows the exact cell transition: accepting c0 → c1 also hides it
when a later document revision changes only other cells. A new cell revision
c2 is not covered by that acceptance. Accepted deletions have no source body;
their discussion remains accessible.

**Undo** restores only that cell to its start-revision state (including restoring
a deleted cell or removing an inserted cell). It appends history; it does not
erase operations. If that cell has changed since the reviewed endpoint, undo
refuses to overwrite it. Refresh and choose a current comparison instead.
Wait for running cells to finish before undoing; undo does not interrupt them.
Accepted changes can still be undone. Neither action resolves comments.
To request further changes, comment in the cell thread rather than pressing X.

## Automation

Discover live signatures with comments.help() and reviews.help(). Use explicit
notebook targets. The historical reviews namespace remains for compatibility;
the direct comment/assess methods do not require a create/submit workflow.

```javascript
const target = { uri: "local://file/<notebook-id>" };
const versions = await revisions.list({ target });
const start = versions[0];
const end = versions.at(-1);
const selection = { target, startRevisionId: start.id, endRevisionId: end.id };
await revisions.label({ target, revisionId: end.id, name: "Codex response",
  description: "Addressed setup comments", author: { displayName: "Codex", kind: "agent" } });
const preview = await reviews.preview(selection);
const thread = await reviews.comment({
  ...selection, content: "The setup changes are clear.",
  author: { displayName: "Codex", kind: "agent" },
});
await comments.reply({ target, commentId: thread.id, content: "Thanks." });
await reviews.assess({ ...selection, outcome: "good_enough" });
await reviews.decideCell({ ...selection, cellId: "<cell-id>", decision: "accept" });
// Destructive: restores this cell to the start revision; guarded against later edits.
// await reviews.decideCell({ ...selection, cellId: "<cell-id>", decision: "undo" });
```

Supply cellIds in selection to scope feedback. Supply cellId and optionally
side: "base" or "head" plus sourceRange: { start, end, unit: "utf-16" } to
reviews.comment to discuss part of a cell. The exclusive-end range is validated
against the frozen snapshot; the quote is derived from it.

Use comments.add with cellId for ordinary editor comments. Read comments.list
with status: "all" and inspect rawAnchor for the complete historical target.
An edit's reason is not a discussion message. comments.resolve/reopen acts on
the root comment ID, not the comparison ID.

API author labels are unverified attribution; missing/blank labels become
unknown. UI submissions resolve the current Drive identity, preserving
service-account identity rather than inferring an impersonating human.
Replies retain their own authors. All .runme feedback is stored in the notebook,
not in Google Drive's separate comments service.

Legacy reviews.create/submit/linkThread and old persisted review records remain
readable. suggestions.list refers to the earlier per-operation accept/reject
model, not the scoped comparison described here.
