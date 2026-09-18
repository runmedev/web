# Inspect training examples for a notebook

## Draft boundary

Design: [20260912_training_examples.runme](https://web.runme.dev/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1ZxXleLr8obZjsgf8ytAbJ9YM0cI3YSJl%2Fview).

This draft uses explicit AppKernel JS calls: `trainingExamples.extract`, `prepare`,
`preview`, `encodeSftExample`, and `encodeJsonl`. Results stay in memory. Saving,
naming, opening and viewing notebooks never creates `.runme.examples` files.
Existing old sidecars are untouched. Dataset export and upload are explicit recipe
steps; no automatic training or Drive sync is performed.

The encoder produces user-only `messages` plus a top-level string
`reference_answer`, not the public assistant-target chat SFT format. Browser JS
can explicitly call `uploadOpenAIJsonl`, `submitTrainingJob` and `getTrainingJob`.
Set the OpenAI key and endpoint in Authentication Settings, or supply an ephemeral
`apiKey` to each function. Never put a literal secret in notebook source.
The saved key is unencrypted localStorage, scoped to this origin and endpoint.
Only run trusted notebook code. The target endpoint must allow browser CORS.

## Journey

1. Open a `.runme` notebook and name a revision. This labels each cell version
   positively against its preceding named revision, or the empty notebook.
   Edit multiple cells and name another revision: each changed cell gets an
   isolated example; unchanged cells remain baseline context.
2. Choose **Review suggestions**, then **Training examples**.
3. Confirm the left panel shows the example count and a labeled example selector.
   Navigate with the selector and previous/next buttons. End buttons are disabled
   at the boundaries. Each example scrolls the diff pane to its first changed
   cell (including deletions and moves), without stealing keyboard focus from
   the navigation control or scrolling the entire page.
4. Confirm each label stays attached to the correct diff while rapidly navigating.
   The viewer replays the example's self-contained `base` and `diff` NotebookRecord
   arrays, not the latest document head. A loading state
   replaces the previous diff until the new one arrives.
5. Confirm insertions/deletions and inline text changes use the review renderer.
   Reorders and language changes have explicit annotations; unchanged cells remain
   as context. Expand **Classifier input** to inspect the actual normalized input.
6. Inspect label provenance and revision references. Comments, outputs, author
   metadata, opaque cell IDs, and the acceptance label are absent from the input.
7. Record a review-specific cell Undo, even in a multi-cell comparison. Refresh
   examples; confirm the negative example changes only that cell, not its
   neighbors or the inverse undo. Explicit decisions override named-positive
   inference. Conflicting explicit decisions are deferred with a diagnostic.
   Comment on an intermediate cell version absent from named snapshots: it
   yields a negative, even if the latest cell has since been fixed. Replies do
   not duplicate the example. A named snapshot overrides this comment inference.
8. Collapse the left panel and restore it. Switch to **Compare changes** and back;
   the comparison selection and the selected example remain intact.
9. Edit/name another revision in the editor. The viewer stays on the selected
   example until **Refresh examples** is clicked.
10. Run `extract(notebookUrl)` for each source and collect the returned arrays;
    `preview(examples)` displays that exact list. Filter by notebook and cell and
    check filtered navigation. Check that a copied Markdown notebook link, a bare Drive URL, and a Runme
    share URL (including surrounding whitespace) resolve to the same source.
    The short API throws if there are extraction
    diagnostics; `extract({source: {driveFileId}})` returns examples plus issues
    for inspection. `prepare(example)` replays the records without accessing the
    source notebook. Extraction must not write a sidecar or change history.
    The Cell filter follows current document order and shows a cell number and
    outline heading (or first non-empty line). Missing cells remain selectable
    at the end. Equal cell IDs in different source notebooks filter separately.
11. Encode rows using `await trainingExamples.encodeSftExample(input, accepted)`
    and `await trainingExamples.encodeJsonl(rows)`. Verify one JSON object per line,
    final LF, and no label in the prompt. Assign whole document families to train
    or validation, detect feature overlap, and persist a manifest only explicitly.
    One source family is a smoke test, not an independent validation dataset.
12. Open Authentication Settings → OpenAI API. Save a key with its endpoint;
    verify the password field clears and the saved status appears. Reload and
    verify the key is still configured without revealing it. Clear removes it.
13. Explicitly upload each reviewed split using `uploadOpenAIJsonl({jsonl, filename})`.
    Record each returned ID in an OPFS manifest before continuing. Submit with
    `submitTrainingJob({job})` only after reviewing the endpoint-specific payload
    and resource cost. Use `getTrainingJob({id})` to read status. Tests mock these
    network calls and must not upload user data or allocate paid resources.

## Failure cases

- Invalid or inaccessible source: the AppKernel cell reports the actual API
  error, including structured rejection details, instead of `[object Object]`.
  Correct the link and rerun that cell; it must clear the previous error and
  open the selected examples with a readable example count.
- No eligible pair: show actionable empty state, not a broken diff.
- Missing/corrupt history or unsupported records: fail extraction without
  changing source history; the notebook remains independently editable.
- Worker failure or missing OPFS source: report an example error, not a failed
  notebook save. Retrying worker startup is supported. Explicit cancellation
  terminates page-local worker jobs; there is no durable background queue.
- Multiple incomparable named predecessors: defer pairing with a warning.
- A cell decision over a larger multi-cell delta: isolate the assessed cell;
  unchanged/unassessed context stays at the baseline. Scope-only assessments
  are not cell labels. Ordinary anchored comments provide weak negative evidence.
- Historical naming: regenerate baselines; deduplicate unchanged cell versions
  across unrelated edits and aliases of the same named snapshot.
- Concurrent content and position edits must remain distinct cell versions:
  a comment on a moved cell must not label a later merged content update.
- Incomplete dependencies/transactions anywhere in the selected history fail
  extraction instead of exporting a valid prefix. Recipe-provided records and
  payloads are validated and sanitized too; malformed base cells, raw metadata,
  opaque identities and position actors must not slip into classifier input.

## PR #379 review verification (2026-09-18)

- Rebased on main `0b987b3` and compared against the current design notebook,
  including its revised Generating Examples section and comment history.
- Fixed incomplete-history partial export, concurrent-register label collisions,
  native-payload metadata leakage, and moved-cell navigation focusing a neighbor.
- Full app suite: 1,614 tests passed; workspace console package: 7 tests passed.
  Production build passed. Typecheck reports the same 125 existing diagnostics
  on this branch and a separate clean-main checkout, with no feature diagnostics.
- Real in-app browser against the built app, using a local synthetic `.runme`
  notebook: named baseline, commented intermediate edit, named final edit yielded
  3 accepted and 1 rejected example; preparation and encoding yielded 4 JSONL
  rows; source revision unchanged. The viewer showed the historical rejected
  edit rather than the current head, cell order/snippets, and an independent
  Cell filter. No user data was uploaded and no training job was submitted.

## Automated coverage

- `model.test.ts`: causal revision pairs, canonical replay, reverse negatives,
  metadata exclusion, no-ops, historical naming, conflicts and scoped decisions.
- `cellVersions.test.ts`: implicit baseline, per-cell updates/deletes/moves,
  historical comments, label precedence, reply deduplication and arrival order.
- `storage.test.ts`: read-only extraction, portable source references, options and
  corruption handling without sidecar writes.
- `client.test.ts`: explicit worker dispatch, cancellation and startup recovery.
- `encoding.test.ts`: native payload replay, label separation, JSONL and multipart
  validation. No real data upload occurs in tests.
- `runtime.test.ts`: source resolution, explicit APIs and recipe-selected lists.
- `openaiTraining.test.ts`: saved/ephemeral keys, endpoint binding, no redirects or
  retries, sanitized errors, multipart upload, submission validation and status.
- `OpenAISettings.test.tsx`: masked independent save and clear controls.
- `TrainingExamplesView.test.tsx`: navigation, labels, real review cell rendering,
  notebook/cell filters, stale-response isolation, empty/error/warning states and refresh.

These component/unit tests do not substitute for browser OPFS/worker execution or
an authenticated upload integration check. Upload success does not establish
training-schema acceptance or start a training job. Reconcile timeouts before
retrying POST. Never store credentials in notebook source, outputs or logs.
