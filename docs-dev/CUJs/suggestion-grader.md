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
   cannot decorate new comparisons. Hidden tabs send no requests.
5. Disable predictions or change credentials/model. Old results are invalidated.
6. Simulate refusal, incomplete output, invalid boolean and HTTP/network errors.
   Controls remain usable and neutral with a textual diagnostic; no automatic retry.
7. Accept/undo manually and verify the existing review semantics are unchanged.

## Training example predictions

1. With a configured, enabled grader, open Training examples. Only the selected
   example is sent for inference, using its exact classifier input, including all
   operations of a multi-cell example. Its label and provenance are not sent.
2. Verify Model prediction shows Accepted (true) or Rejected (false), the model
   ID, and agreement/disagreement with the original example label. The label,
   source notebook, review decisions and exported dataset remain unchanged.
   The example statistics show the filtered count out of the loaded total and
   accepted/rejected label counts. Notebook/cell filters update these counts;
   navigating examples or receiving a model prediction does not change them.
3. Navigate quickly or hide the view while inference is pending. Cancel obsolete
   work and never show a stale prediction alongside another example. Returning
   to an identical input reuses the view's bounded in-memory cache.
4. Disable/reconfigure the grader or remove its key. Invalidate old results and
   show configuration guidance. Errors display no prediction, not rejection,
   and do not trigger automatic retries.

## Agent update with grading

1. Read the explicit target with `notebooks.get({uri})`. Call
   `notebooks.update({target:{uri}, expectedRevision:doc.handle.revision,
   operations, grade:true})` through browser JS or the WebMCP sandbox.
2. Verify edits persist before requests are sent. Each net changed cell gets its
   own content-only prediction; metadata/output-only updates send no requests.
3. Edit the notebook again while persistence/inference is pending. Verify the
   earlier update is graded against its captured snapshots, not these later edits.
4. Return a model error for one cell. Verify successful cell results are retained,
   `grading.status` is `error`, and the update is not rolled back or retried.
5. Fail persistence. Verify the returned grading diagnostic distinguishes uncertain
   persistence from inference, and no request is sent. Reconcile before retrying.
6. Omit `grade` and verify the existing update path sends no inference request.
   No model output becomes a review decision, comment, label or training example.

## Automated evidence

- `suggestionGrader*.test.ts`: training parity, scoping/replay, secret redaction,
  settings validation, strict parsing and runtime target selection.
- `useSuggestionPredictions.test.tsx`: cancellation, stale response suppression,
  concurrency, caching, errors and configuration invalidation.
- `useExamplePrediction.test.tsx`, `TrainingExamplesView.test.tsx`: exact
  multi-cell classifier input, independent labels, active-view gating, caching,
  stale response suppression and configuration/error states.
- `SuggestionGraderSettings.test.tsx`, `SidePanel.test.tsx`: opt-in/key handling
  and navigation; `NotebookReviewFlow.test.tsx`: rendering and human decisions.
- `codeModeExecutor.test.ts`, `sandboxJsKernel.test.ts`: shared API exposure.
- `runmeConsole.test.ts`, `suggestionGraderUpdate.test.ts`: immutable update
  snapshots, persistence/error isolation, per-cell scope and bounded concurrency.
- Browser artifacts belong in `app/test/browser/test-output/`; never capture keys
  or private notebook content in public CUJ artifacts.
