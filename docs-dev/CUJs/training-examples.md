# Inspect training examples for a notebook

## Draft boundary

Design: [20260912_training_examples.runme](https://web.runme.dev/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1ZxXleLr8obZjsgf8ytAbJ9YM0cI3YSJl%2Fview).

This draft generates a reference-only `.runme.examples` OPFS sibling. It does
not upload that sidecar to Google Drive or train a model. The viewer is available
on demand. Set `VITE_TRAINING_EXAMPLES=true` when building/running Vite to enable
automatic reconciliation after local history changes and on notebook open.
The default is off until Drive synchronization and large-history performance
are validated. Existing notebook save/sync behavior is unchanged.

## Journey

1. Open a `.runme` notebook, name a baseline revision, edit one or more cells,
   and name the next revision. Repeat for a second transition.
2. Choose **Review suggestions**, then **Training examples**.
3. Confirm the left panel shows the example count and a labeled example selector.
   Navigate with the selector and previous/next buttons. End buttons are disabled
   at the boundaries.
4. Confirm each label stays attached to the correct diff while rapidly navigating.
   The viewer uses the stored pair, not the latest document head. A loading state
   replaces the previous diff until the new one arrives.
5. Confirm insertions/deletions and inline text changes use the review renderer.
   Reorders and language changes have explicit annotations; unchanged cells remain
   as context. Expand **Classifier input** to inspect the actual normalized input.
6. Inspect label provenance and revision references. Comments, outputs, author
   metadata, opaque cell IDs, and the acceptance label are absent from the input.
7. Record a review-specific cell Undo where that cell is the only changed cell
   in the comparison. Refresh examples; confirm the negative example shows the
   original forward proposal, not the inverse undo. Conflicting named-positive
   evidence is retained and flagged.
8. Collapse the left panel and restore it. Switch to **Compare changes** and back;
   the comparison selection and the selected example remain intact.
9. Edit/name another revision in the editor. The viewer stays on the selected
   example until **Refresh examples** is clicked.
10. Reopen the notebook. With automatic generation enabled, verify the source
    history regenerates any missing derived index. Confirm the source notebook is
    not changed by extraction. The viewer explicitly reports local-only storage.

## Failure cases

- No eligible pair: show actionable empty state, not a broken diff.
- Missing/corrupt history or unsupported records: fail extraction without
  overwriting the prior sidecar; the notebook remains independently editable.
- Missing Web Locks, worker failure or OPFS quota: report an example error, not
  a failed notebook save. Retrying worker startup is supported.
- Multiple incomparable named predecessors: defer pairing with a warning.
- A cell decision over a larger multi-cell delta: defer rather than mislabeling
  unrelated changes. Scope-only assessments and ordinary comments are not labels.
- Historical naming: regenerate neighboring pairs, removing obsolete partitions.

## Automated coverage

- `model.test.ts`: causal revision pairs, canonical replay, reverse negatives,
  metadata exclusion, no-ops, historical naming, conflicts and scoped decisions.
- `storage.test.ts`: reference-only JSONL, retries, changed-source publication,
  preservation on corruption/schema mismatch/quota errors.
- `client.test.ts`: dedicated worker messages, default-off automatic generation,
  bounded coalescing and startup-error recovery.
- `TrainingExamplesView.test.tsx`: navigation, labels, real review cell rendering,
  stale-response isolation, empty/error/warning states and refresh.

These component/unit tests do not substitute for a browser OPFS/worker smoke
test on supported browsers before enabling automatic production by default.
