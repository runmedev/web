# Fixed notebook review rounds

## Preconditions

Run the local app on localhost:5173. Use a dedicated `.runme` notebook. The
recorded journey uses a fresh signed-out profile, so reviewer attribution is
explicitly unknown. Test the signed-in human path separately; never fabricate
Google identity to make a recording look authenticated.

## Journey and assertions

1. Insert Markdown and code cells, immediately open the notebook, execute the
   code cell, then name the revision. Open Review suggestions; the editor stays
   adjacent. Select <start new review> in Review. Filter named revisions, select
   empty→named head, and verify a live preview including outputs. Start the review;
   the pickers disappear and the endpoints become fixed. Pending edits survive.
2. Add a cell-specific discussion and a whole-review discussion. Submit Request
   changes. The left panel shows one review-wide conversation; the cell thread
   appears under its diff. The shared-draft notice stays visible.
3. Edit the live cell through WebMCP and reply as Codex to the real root ID.
   Capture Round 2 from Round 1's head and link both unresolved threads. Assert
   an incremental text diff, identical thread IDs, and outdated quoted context.
4. Start a discussion on an existing suggestion, then reply to its returned
   comment ID. Assert the original suggestions, diffs, and decisions are
   unchanged. Cell and suggestion discussions remain separate anchors.
5. Navigate back to Round 1. Its diff is byte-for-byte unchanged. Return to
   Round 2, resolve only the addressed thread, and approve. The other thread
   stays open and the edited notebook remains applied.
6. Reload the page. Assert every review endpoint, outcome, thread link, message,
   author, and status matches the pre-reload data.
7. Reject then accept an individual suggestion; the live document changes but
   historical round endpoints remain unchanged.
8. Manually verify the signed-in Drive identity path and Drive sync/reopen.
9. In both diff views, use Comment on cell; select part of inserted, removed,
   and unchanged source and choose Comment on selection (including right-click).
   Verify the inline cell composer quote, source side, root and reply, and persistence
   after reopening. Check repeated words and Unicode offsets. A mixed red/green
   or cross-cell selection must fail closed. Switching rounds must clear the
   pending target. Read-only mode must disable these actions. Text selection
   is source-only; linked resources use whole-cell comments.
10. Verify the review panel has no whole-review/cell target dropdown. Sending
    successive review-wide messages must reply to one root, not create a new
    thread each time. Legacy review-wide roots remain visible in the single
    conversation, while cell threads remain in the diff.
11. Name an older revision after later edits. Verify its date and content stay
    unchanged. End choices exclude the start and earlier/unrelated revisions.
    Switch endpoint choices rapidly; stale preview responses must not win.
    Pick an already-reviewed pair: Continue review must open it without creating
    another. Concurrent API starts converge on the same ID. Reload preserves
    labels, endpoints, and discussions. Preview mode cannot post comments.

## Automated evidence

`app/test/browser/test-scenario-notebook-reviews.ts` records steps 1–7 and the
named-filter/preview/continue portions of step 11 against the real local app.
The latest recording passes 13 checkpoints. It implements a minimal WebMCP host for an isolated browser;
all notebook mutations invoke the app's registered ExecuteCode tool. UI
navigation uses browser locators. This is not a fake notebook implementation.
Selection mapping and composer submission are covered by component tests in
`diffSelection.test.tsx` and `NotebookReviewFlow.test.tsx`; the integrated
storage test verifies API ranges survive reopening and upstream reconciliation.
Step 9's real-browser input interactions still require manual validation.

Run with Node 24 and an installed `playwright-core` module:

```sh
CUJ_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
CUJ_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
node app/test/browser/test-scenario-notebook-reviews.ts
```

Outputs live under `app/test/browser/test-output/notebook-review-<timestamp>/`:
`result.json`, per-step screenshots and visible-text snapshots, and an actual
WebM recording. A failed attempt is labeled failed, not presented as passing
evidence. Sync and signed-in identity are not claimed by the signed-out run.
