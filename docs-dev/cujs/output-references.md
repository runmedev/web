# Versioned output references

## Preconditions

- Run the current branch's dev server and open it in the browser.
- Use a local .runme notebook; no Drive account or backend runner is required for the AppKernel case.

## Journey and assertions

1. Create a .runme notebook and run an AppKernel JavaScript cell printing `Baseline result: 42`.
2. Call `notebooks.outputLink({target: {uri}, cellId, outputIndex: 0, itemIndex: 0})`, then append a markup cell with languageId `runme-reference` and that source. The UI's Copy output link calls the same domain action.
3. Change Methods to print `New result: 99` and execute it. Assert the reference still contains `Baseline result: 42` while Methods contains `New result: 99`.
4. Expand View executed code. Assert it contains the original program, not the new one. Reload the page and assert the reference still resolves.
5. For the HTML case, import `app/test/fixtures/notebooks/output-references.runme` using documents.update on a newly created local .runme notebook, then reopen it. This is a synthetic saved-output fixture, not a live Python execution.
6. Assert the reference embeds only the table item, not the sibling text MIME item. The code input and its output items must have equal widths, with HTML filling its item width and no visible MIME header or Copy output link text. Verify the overlaid link icon still copies a versioned reference. Hover/focus anywhere in the input/output group must highlight the whole group. Both HTML iframes should measure less than 150px high for this small table; they retain sandbox `allow-scripts` without `allow-same-origin`.
7. Double-click the rendered reference, including inside its HTML table. Assert the source editor is focused. Press Escape and assert render view returns. Read-only references must not enter edit mode. Modify the reference version to an absent operation. Assert a local unavailable-reference message; Edit reference and ordinary notebook editing remain available. Restore the original link.
8. Export to .ipynb. Assert the reference becomes explanatory Markdown with no executable code/output or Runme cell envelope pretending to preserve history.

## Evidence

Save screenshots and assertion output under `app/test/browser/test-output/`. Unit/component regressions live in outputReference.test.ts, OutputReferenceCell.test.tsx, HtmlOutput.test.tsx, ipynb.test.ts, and the runtime/bridge tests. The browser journey can be driven through the public WebMCP notebook API; DOM inspection is only needed to check rendered content and iframe dimensions.
