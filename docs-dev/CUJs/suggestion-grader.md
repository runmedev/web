# Advisory suggestion grader

## Preconditions

- A .runme notebook has at least two content revisions and a comparison tab.
- AI grader settings are initially disabled. Automated tests mock fetch; live
  checks require a user-provided OpenAI key/model and explicit opt-in.

## Journey

1. Open AI grader from the left-hand sparkle icon. Set model, organization,
   project and optional key. No request occurs before enabling and saving.
2. Open Compare changes. Baseline context plus a single cell's content operations
   go to Responses with the identical training prompt and store:false.
3. A true prediction highlights accept green; false highlights undo red. Hover
   and accessibility descriptions explain the prediction without changing actions.
4. Change revisions/scope or hide the tab while a request is pending. Old results
   cannot decorate new comparisons. Hidden/training-example tabs send no requests.
5. Disable predictions or change credentials/model. Old results are invalidated.
6. Simulate refusal, incomplete output, invalid boolean and HTTP/network errors.
   Controls remain usable and neutral with a textual diagnostic; no automatic retry.
7. Accept/undo manually and verify the existing review semantics are unchanged.

## Automated evidence

- `suggestionGrader*.test.ts`: training parity, scoping/replay, secret redaction,
  settings validation, strict parsing and runtime target selection.
- `useSuggestionPredictions.test.tsx`: cancellation, stale response suppression,
  concurrency, caching, errors and configuration invalidation.
- `SuggestionGraderSettings.test.tsx`, `SidePanel.test.tsx`: opt-in/key handling
  and navigation; `NotebookReviewFlow.test.tsx`: rendering and human decisions.
- `codeModeExecutor.test.ts`, `sandboxJsKernel.test.ts`: shared API exposure.
- Browser artifacts belong in `app/test/browser/test-output/`; never capture keys
  or private notebook content in public CUJ artifacts.
