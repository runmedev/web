# Comment-first notebook collaboration

## Preconditions

Run localhost:5173 with automatic reload/HMR disabled. Use a dedicated .runme
notebook, never the user's working document. The automated recording uses an
isolated signed-out profile and unknown authorship; it does not verify Google
authentication or Drive upload.

## Journey and assertions

1. Read the initial document in edit view and leave cell feedback. Name that
   revision. Edit the same cells as Codex and reply to the original root.
2. Open the adjacent suggestion tab. Select start/end revisions. The diff shows
   the original thread and reply immediately, without Start/Submit review or
   a review-round/target dropdown. Browsing writes no comparison record.
3. Filter named revisions. Labels do not change the last content-change date;
   end choices strictly extend the start's operation set.
4. Select a section or heading range. Include descendant/body cells and exclude
   unrelated cells. The selected pair plus cell-ID scope defines ONE suggestion.
5. Add a diff-source comment with exact quote, side, and UTF-16 range. Show it
   in the right gutter beside its cell, not below it or in the left panel. A blue
   right-edge marker focuses that cell's gutter; unannotated cells have no marker.
   The composer also opens in the gutter. The left panel has one suggestion-wide
   conversation. Successive messages reply to the same root.
6. Assess the scope as Good Enough. Return to edit view: the same source comment,
   whole-suggestion conversation, and replies remain visible. Reply and return
   to diff; verify the same thread ID and message.
7. Select a deleted section using the start outline. Assess it as Needs More Work.
   Different scopes have independent feedback. Neither assessment edits content,
   rejects operations, or resolves comments.
8. Reload and reselect the desired comparison. Its stored scope, snapshots,
   comments, replies, authors, and assessments must survive unchanged.
9. Make a second AI revision. Compare first response to second response. Relevant
   cell threads retain their identities and original quotes; stale context is
   marked. The old comparison still reconstructs its original content.

## Additional regression coverage

Component/storage tests cover source selection and composer submission, repeated
words/Unicode, mixed-side and cross-cell rejection, readonly controls, stale
preview responses, one-root replies, noncontiguous scopes, invalid/empty scopes,
canonical duplicate/reordered cell sets, and historical snapshots.

The comparison panel has no numbered Change buttons. Reusing the existing
document outline to navigate long diffs is deferred; the section-range controls
continue to select suggestion scope, not provide a separate navigation list.
Collapsing the left comparison panel expands the diff canvas. Reopening it must
preserve revision/scope selections and unsent discussion drafts.
The right comments gutter collapses independently. Hiding both panels must give
the diff more room; a blue cell marker must reopen the right gutter without
discarding unsent cell comments or replies.
Cell commenting uses a blue upper-right bubble and the right-click menu. The menu
includes both whole-cell and selection actions; selection is disabled without a
valid single-side range. No cell-number/status or comment-action text rows appear
between cells. Verify the icon and a selected-source context-menu composer.

Manually verify pointer-driven selection/comment submission and the signed-in
Drive sync/reopen path separately. Do not describe API-driven rendering checks
as pointer-input or authentication tests.

## Automated evidence

`app/test/browser/test-scenario-notebook-reviews.ts` implements the journey with
the real app. All notebook/comment mutations invoke its registered WebMCP tool;
browser locators control navigation. No fake notebook backend is used.

Run with Node 24 and an installed playwright-core module:

```sh
CUJ_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
CUJ_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node app/test/browser/test-scenario-notebook-reviews.ts
```

Outputs are under `app/test/browser/test-output/notebook-review-<timestamp>/`:
result.json, screenshots, visible text, and an actual WebM recording. Only a
result.json with status passed is passing evidence. Historical recordings of the
explicit-start/submit workflow do not verify this iteration.
