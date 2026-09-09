# View architecture audit — 2026-09-09

Source of truth: the Data model, View architecture and API sections of
[20260905b_design_review_flow.runme](http://localhost:5173/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1HitOWjIhCx88vSutNcHuFHPaXcM3uVL5%2Fview).
This audit covers the current `feature/notebook-review-rounds` worktree. It does
not claim that the changes are committed, merged, or deployed.

## Discrepancies addressed

| Requirement | Implementation and regression coverage |
| --- | --- |
| Immutable source anchors; independent start/end locations | `commentAnchorMapping.ts` maps historical code-point ranges per displayed side, caches each source-pair edit map, checks grapheme boundaries, and fails closed on ambiguity or bounded-work exhaustion. Tests cover repeated text, overlapping edits, Unicode, empty ranges, and deleted cells. |
| One conversation with multiple anchors | Materialization projects historical sources for root and reply anchors without serializing quotes. Both gutters keep one conversation and expose separate location links and historical context. Unlocated conversations remain accessible. |
| Exact visible affordances | Diff spans, rendered Markdown CSS highlights, and Monaco decorations use mapped source ranges. Blue cell-edge markers remain when the gutter is hidden. Markdown syntax or destinations without an exact visible projection do not highlight unrelated text. |
| Selection-time revision | Editor drafts capture and flush the displayed snapshot at composition start. A concurrent visible change or unavailable frontier fails closed. Later sends retain those captured heads. |
| Independent panels and mounted tabs | Editor comments stay mounted when hidden, preserving drafts. Comparison panels collapse independently. Comment navigation is scoped to the current mounted notebook view. |
| Canonical APIs | `revisions.create` replaces the public checkpoint name in dispatch, sandbox and help. Local notebook comment calls require explicit targets. Replies may add historical anchors without changing the root comparison. Equivalent explicit checkpoint frontiers are minimized before deduplication. |
| Enter submission | Enter submits; Shift+Enter adds a newline. IME, repeated keys, busy state and a synchronous in-flight guard prevent accidental duplicate sends. |

The superseded review model is not the V2 write path. Legacy readers/adapters
remain for existing notebooks; migration is explicit and creates a separate copy.
No live design notebook was migrated or used as test data.

## Verification

- The final app suite passed all 1,354 tests across 134 files, including the
  selection-time capture and canonical-frontier regressions.
- `runme run build test` passed. Run the app suite afterward, not concurrently:
  the build cleans shared package artifacts that app tests import.
- The isolated browser CUJ passed all 17 checkpoints. Evidence is in
  `app/test/browser/test-output/notebook-review-1788974532999/`, including
  `result.json`, screenshots, and a recorded WebM. It verifies exact blue diff
  underlines and rendered Markdown CSS ranges, click-to-open, adjacent tabs,
  scope filtering, draft-preserving collapse, historical threads, accept/undo,
  and reload persistence.
- Repository-wide TypeScript checking remains blocked by existing errors,
  including pending-comment union narrowing and unrelated auth/storage types.
  A passing Vite build is not a clean typecheck.

## Deliberate limits

Monaco decorations are implemented, but their native pointer interaction is not
covered by the recorded browser journey. The isolated signed-out test does not
verify Drive authentication or upload. Combined bulk decisions plus revision
naming and outline-based diff navigation remain explicitly deferred in the
design; this audit does not mark them implemented. The user's open notebook and
manual-refresh development workflow were left unchanged.
