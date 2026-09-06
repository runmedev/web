---
name: notebook-review-rounds
title: Review notebook revisions
order: 19
description: Capture fixed notebook review rounds, discuss changes across revisions, and use the comment and review APIs.
---

# Review notebook revisions

For a `.runme` notebook, right-click its tab and choose **Review suggestions**.
The review tab sits beside the editor. The left panel contains review rounds,
change navigation, a single review-wide conversation, and submission controls.
Cell-specific discussions stay beneath their cells in the diff. There is no
whole-review/cell target dropdown; use the diff's comment actions for cell feedback.

Choose **\<start new review\>** in the Review dropdown. Select a start revision
and a later end revision; the diff updates as you change either selection.
This is only a preview: no review or discussion is created yet. **Start review**
fixes both endpoints and the cell scope, then opens the review-wide conversation. If that pair and scope already
has a review, the button reads **Continue review** and opens it instead.
Existing reviews show their fixed endpoints, not editable revision pickers.

Expand **Name a revision** to give any historical revision a name and description.
The picker shows name, description, and the date of its last notebook change in
your local time zone. Naming a version does not change that date or create a new
version. **Named revisions only** filters the pickers; the empty baseline remains
available. End revisions must strictly extend the start's changes, even if clocks
disagree. Names and reviews travel with the `.runme` file.

Later edits and renamed versions never change a started review's diff. Concurrent
starts of the same pair and cell-ID set converge on one review; different scopes
can be reviewed independently. Existing whole-document review identities are retained.

## Review a section

Select **Heading / section range** under Review scope. Choose **From heading**
and **Through section** using the indented outline. A section includes its
subheadings and body through the next heading of equal or lower depth. Choose
the same heading in both fields to review one section, or extend the range to
review adjacent sections. The preview immediately filters to those cell IDs.

**Outline from** chooses the end or start revision; use the start outline for
deleted sections. Scope consists of the cells in the chosen revision, not an
automatically expanding region. For a mix of deleted and newly inserted cells,
the API can supply IDs from both endpoints. Every selected ID must exist in at
least one endpoint. Multiple headings in one cell select the whole cell; no
sub-cell scope is implied. Unchanged selected cells remain visible for context.

The persisted definition stores IDs, not heading text or cell indexes. Future
edits, renames, and moves cannot change the selected scope. Omit `cellIds` for
the whole document; an explicit list must be nonempty and may be noncontiguous.

Comments are shared immediately, including while a round is Draft. Submit
**Good Enough** or **Needs More Work** to assess just this review’s scope. Old
Approve/Request changes records display with the equivalent new wording;
legacy Comment submissions remain readable. Submission does not
revert edits or resolve discussions. Resolve an addressed discussion explicitly.
Unresolved cell threads carry forward only inside the next scope. Review-wide
feedback carries forward only between equal scopes; replies
and resolution state are shared rather than copied. **Individual suggestions**
opens the original accept/reject view for explicit undo or restoration.

## Comment on the diff

Both review rounds and individual suggestions support **Comment on cell**.
Select text in the diff, then choose **Comment on selection** above the cell
or in its right-click menu. In review rounds, the composer opens under the cell
and shows the quoted target; individual suggestions use their discussion panel.
**Comment on previous cell** targets the whole old version.

Removed text anchors to the base revision; added text anchors to the proposed
head. Unchanged text defaults to the head. Select text from one side at a time:
a selection containing both removed and added text has no single source range.
Linked resources support whole-cell comments, not selection within the resource.
The diff displays source text, so text ranges refer to source, not rendered Markdown.
Comments remain in the `.runme` operation log, including their frozen revision,
cell, side, exact quote, and optional UTF-16 source range.

## Automation

Use an explicit notebook URI. Discover live signatures with `comments.help()`
and `reviews.help()` before invoking them.

```javascript
const target = { uri: "local://file/<notebook-id>" };
const versions = await revisions.list({ target });
const start = versions[0];
const end = versions.at(-1);
await revisions.label({ target, revisionId: end.id, name: "Version",
  description: "Codex addressed comments", author: { displayName: "Codex", kind: "agent" } });
const preview = await reviews.preview({ target, startRevisionId: start.id, endRevisionId: end.id });
const round = await reviews.create({ target, title: "Review operational checks",
  startRevisionId: start.id, endRevisionId: end.id });
// A separate scoped review; IDs may come from either frozen endpoint.
const cellIds = [preview.after.cells[0]?.refId, preview.before.cells[0]?.refId].filter(Boolean);
const scoped = await reviews.create({ target, startRevisionId: start.id,
  endRevisionId: end.id, cellIds });
await reviews.submit({ target, reviewId: scoped.id, outcome: "good_enough" });
const changes = await suggestions.list({ target });
const thread = await comments.add({
  target,
  suggestionId: changes[0].id,
  content: "This change makes the check actionable.",
  author: { displayName: "Codex", kind: "agent" },
});
await comments.reply({
  target, commentId: thread.id, content: "Added the missing example.",
  author: { displayName: "Codex", kind: "agent" },
});
```

`comments.add` accepts a `reviewId`, a `suggestionId`, or a `cellId`; a review
or suggestion may additionally specify a cell. To target part of that cell,
pass `side: "base"` or `"head"` and
`sourceRange: { start: 0, end: 10, unit: "utf-16" }`. The end is exclusive;
the range is validated against that side of the frozen comparison. These are different discussion targets. An
edit's reason is not a discussion, and a suggestion ID is not a comment ID.
Read back `comments.list({ target, status: "all" })` and inspect `rawAnchor` to
verify membership. Use `reviews.linkThread` to share an existing root with
another round without copying its messages.

API authors are supplied attribution, not authenticated identities. Missing or
blank labels become unknown. Human UI submissions query the current Drive
identity and fall back to unknown if unavailable. Replies have their own
authors; historical authors do not change when accounts change. Native Drive
comments continue to use provider-controlled authorship.

If Drive uses an impersonated Google service account, the recorded author is
that service account, not an inferred human impersonator. The UI labels it
**service account · Google Drive identity**. API callers can supply
`kind: "service-account"`, but—as with all caller labels—cannot claim verified
Google identity through the author argument.
