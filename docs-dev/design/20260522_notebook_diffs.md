# Notebook Diffs

Date: 2026-05-22

Builds on:

- `docs-dev/design/20260409_refactor_notebooks.md`
- `docs-dev/design/20260409_track_drive_versions.md`
- `docs-dev/design/20260511_markdown_serialization.md`

## Summary

Render differences between two versions of the same notebook so users can
understand and resolve changes.

The UI should feel closer to Google Colab's notebook-aware diff than to a raw
JSON diff. Users should see cells as the primary unit, with inline source
changes, output changes, inserted/deleted cells, moved cells when we can detect
them, and metadata changes only when they matter.

Recommended first step:

1. Build a browser-side two-way diff model for Runme notebooks.
2. Render that model with existing cell rendering components in a read-only diff
   view.
3. Defer automatic merge/conflict resolution until the two-way diff UI is
   usable.
4. Use `nbdime` as the main prior-art reference, not as a dependency for v0.

## Problem

Runme stores editable notebooks as structured protobuf JSON in the local mirror.
Generic line-based diffs do a poor job on that representation because they
highlight storage shape instead of authored content.

The user needs to answer questions such as:

- Which cells were added, removed, or edited?
- Did source code change, or only outputs?
- Did generated execution metadata change?
- Can I accept the local version, the remote version, or a specific cell-level
  change?

These questions come up naturally in sync and version workflows:

- Google Drive revision comparison.
- Local mirror versus upstream conflict resolution.
- Future restore/version history UI.
- Potential git-backed file workflows.

## Goals

- Compare two notebook versions in the browser.
- Show a notebook-aware diff organized by cells.
- Highlight source changes inline for markdown, HTML, and code cells.
- Show output changes without making generated output noise dominate the view.
- Keep the diff computation independent from the React rendering layer.
- Make the diff model reusable for future conflict resolution.
- Treat execution counters, transient run state, and volatile metadata as
  ignorable by default.
- Support Runme notebooks in V0.

## Non-Goals

- Full three-way merge in the first milestone.
- Exact parity with Google Colab.
- Exact compatibility with `nbdime`'s internal diff format.
- Rendering every rich output type in v0.
- Git integration in the first milestone.
- Converting Runme notebooks to `.ipynb` solely to diff them.
- Direct `.ipynb` diff support in V0.

## Current Implementation Context

The app-facing persistence path is:

```text
NotebookData / editor tabs
  -> local://file/<id>
  -> LocalNotebooks / IndexedDB
  -> optional upstream from LocalFileRecord.remoteId
```

`LocalFileRecord` persists:

- stable local URI,
- upstream URI,
- serialized notebook JSON,
- local checksum,
- last observed upstream checksum/revision metadata,
- sync status/error metadata.

`NotebookData` owns one in-memory `parser_pb.Notebook` and exposes immutable
snapshots for React rendering. Cells have stable `refId` values and include:

- `kind`,
- `languageId`,
- `value`,
- `metadata`,
- `outputs`.

The web app already has browser-side notebook serialization for search sidecars:

- `app/src/lib/markdown/serializeNotebookToMarkdown.ts`

That serializer is useful as a reference for text extraction, but it is not the
right diff representation. A diff needs to preserve cell identity and structure
instead of flattening the notebook to Markdown.

## Prior Art

### Jupyter Notebook Format

Jupyter notebooks are structured JSON documents with top-level `metadata`,
`nbformat`, `nbformat_minor`, and `cells`. Code cells contain source and
outputs. Outputs can be stream text, rich mime bundles, execution results, or
errors. Newer Jupyter notebooks also have stable cell ids.

Source:

- <https://nbformat.readthedocs.io/en/latest/format_description.html>

Design implication:

- Notebook diffing should operate on notebook structure first, not on serialized
  JSON lines.
- Stable cell ids are the best matching key when present. Runme's `refId` can
  play the same role for Runme-native notebooks.

### nbdime

`nbdime` is Project Jupyter's purpose-built tool for diffing and merging
Jupyter notebooks. It provides:

- terminal notebook diffs,
- web-rendered notebook diffs,
- two-way diff,
- three-way merge,
- git and Mercurial integration,
- notebook extensions,
- a REST API,
- a structured JSON-compatible diff format.

Sources:

- <https://nbdime.readthedocs.io/en/latest/>
- <https://github.com/jupyter/nbdime>
- <https://nbdime.readthedocs.io/en/latest/diffing.html>
- <https://nbdime.readthedocs.io/en/latest/merging.html>
- <https://nbdime.readthedocs.io/en/latest/restapi.html>

Important ideas to borrow:

- Diff the logical notebook tree, not the raw file.
- Represent changes as operations over mappings, sequences, and strings.
- Treat generated fields specially. `nbdime` can auto-resolve generated values
  such as execution counters.
- Render image/rich-output diffs differently from text diffs.
- Use three-way merge decisions when resolving conflicts.

Important ideas not to copy directly in v0:

- Do not introduce a Python server dependency only to compute diffs.
- Do not make Runme's diff model depend on `.ipynb` field names.
- Do not adopt the full `nbdime` merge format before we know our conflict UI.

### JupyterLab Git

`jupyterlab-git` is a JupyterLab extension for Git workflows. It exposes file
diffs from the JupyterLab Git panel and supports click-to-diff behavior. It is
useful prior art for where a notebook diff appears in a larger app workflow,
not necessarily for Runme's diff computation.

Source:

- <https://github.com/jupyterlab/jupyterlab-git>

Design implication:

- Diff UI should be reachable from version/sync surfaces, not only from a
  standalone compare page.
- The app should support a read-only review path before it supports write-back
  resolution.

### Google Colab

Colab is the product reference for the target interaction: users compare
notebook versions as notebook cells, not as raw JSON.

Current gaps:

- We should capture screenshots or a short behavior inventory from Colab before
  committing to detailed visual parity.
- Public Colab docs do not appear to define a reusable diff algorithm or API.

Design implication:

- Treat Colab as UX inspiration, not as implementation prior art.

## Proposed Architecture

Separate diff computation from rendering.

```text
base notebook + compare notebook
  -> normalize notebook trees
  -> match cells
  -> compute structured cell diffs
  -> NotebookDiff model
  -> read-only React diff view
  -> later: resolution actions
```

## Code-Centric V0

V0 should expose notebook diffing as browser-kernel functions before we build a
polished product workflow.

Users should be able to write JavaScript in an AppKernel browser cell to:

1. list earlier versions of the current Drive-backed notebook,
2. compute a diff between the local mirror and a selected earlier version,
3. open the rendered diff in an app tab.

This fits the current Runme workflow:

- AppKernel already exposes browser-local helpers such as `notebooks` and
  `drive`.
- Code cells are a natural testing surface for early functionality.
- We can dogfood the diff model without deciding the final sync-conflict UI.
- We can keep the first implementation browser-only.

### Google Drive Version Concept

Use Google Drive `Revision` as the backing concept for earlier Drive versions.

Relevant Drive API facts:

- A file has `revisions`.
- `revisions.list` lists available revisions for a file.
- `revisions.get` fetches revision metadata or content by `fileId` and
  `revisionId`.
- Passing `alt=media` to `revisions.get` returns the revision contents in the
  response body.
- Drive blob revisions can be purged. Non-head blob revisions are typically
  purgeable unless marked `keepForever`.
- `Revision` metadata includes fields such as `id`, `mimeType`, `md5Checksum`,
  `modifiedTime`, `size`, and `lastModifyingUser`.

Sources:

- <https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions>
- <https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions/list>
- <https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions/get>
- <https://developers.google.com/workspace/drive/api/guides/manage-revisions>

Design implication:

- The API should say "available Drive revisions", not "complete notebook
  history".
- V0 should compare the local mirror against a selected available revision.
- If an older revision is missing from Drive's API response, the app should
  report that limitation instead of trying to synthesize history.

### Runtime Helper API

Expose a new helper namespace in the browser kernel:

```ts
type DriveNotebookRevision = {
  id: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  lastModifyingUser?: {
    displayName?: string;
    emailAddress?: string;
  };
};

type NotebookDiffDocument = {
  id: string;
  base: {
    label: string;
    notebook: parser_pb.Notebook;
    revisionId?: string;
  };
  compare: {
    label: string;
    notebook: parser_pb.Notebook;
    revisionId?: string;
  };
  diff: NotebookDiff;
};

type NotebookDiffRuntimeApi = {
  listDriveRevisions(
    target?: { uri: string } | { handle: { uri: string; revision: string } }
  ): Promise<DriveNotebookRevision[]>;

  diffDriveRevision(args: {
    target?: { uri: string } | { handle: { uri: string; revision: string } };
    revisionId: string;
    includeOutputs?: boolean;
    includeMetadata?: boolean;
  }): Promise<NotebookDiffDocument>;

  openDiffTab(diff: NotebookDiffDocument | { id: string }): Promise<void>;

  help(): string;
};
```

Example usage:

```js
const revisions = await notebookDiff.listDriveRevisions();
console.table(revisions.map((r) => ({
  id: r.id,
  modifiedTime: r.modifiedTime,
  md5Checksum: r.md5Checksum,
})));

const diff = await notebookDiff.diffDriveRevision({
  revisionId: revisions.at(-2).id,
  includeOutputs: false,
});

await notebookDiff.openDiffTab(diff);
```

Naming note:

- `base` should be the earlier Drive revision.
- `compare` should be the current local mirror.
- The rendered tab can label them as "Drive revision <id>" and "Local copy".

### Fetching the Earlier Notebook

`diffDriveRevision` should:

1. Resolve the target notebook. If omitted, use the current notebook selected in
   the UI.
2. Look up the local mirror record and require a Drive-backed `remoteId`.
3. Parse the Drive file id from `remoteId`.
4. Call `revisions.get(fileId, revisionId, alt=media)` to fetch the earlier
   blob content.
5. Deserialize the returned JSON into `parser_pb.Notebook`.
6. Compare it with the current local notebook from `notebooks.get`.
7. Return a `NotebookDiffDocument`.

Do not fetch the current version back from Drive for this V0 path. The point of
the flow is to compare "what I have locally right now" against "an earlier
Drive revision".

Open question:

- Existing Drive code tracks `files.headRevisionId` as
  `LocalFileRecord.lastUpstreamVersion.revisionId`. We should confirm whether
  that id can always be passed to `revisions.get` for blob notebook files in our
  current auth/scopes.

### Opening a Diff Tab

`openDiffTab` should register an in-memory diff document and open a local app
route, for example:

```text
/diff/<diffDocumentId>
```

The route should read the diff document from an app-local registry.

This avoids encoding large notebook payloads into the URL and avoids persisting
experimental diff state in IndexedDB. If the user refreshes the page, the app
can show "Diff no longer available; recompute it from the browser kernel."

Future versions can persist diff documents when a stable product workflow needs
shareable or reloadable diff URLs.

### Why Start With Runtime Helpers

This is intentionally developer-oriented.

Benefits:

- We can test Drive revision fetch, notebook diffing, and rendering separately.
- We can write reproducible notebook cells that exercise real Drive-backed
  notebooks.
- We do not need to design the final review button, conflict modal, or version
  picker before validating the diff model.
- The same helper API can later power UI actions.

Tradeoff:

- V0 will not be discoverable for normal users. That is acceptable because the
  main risk is correctness and rendering quality, not entry-point placement.

### Diff Computation

Add a pure TypeScript module:

- `app/src/lib/notebookDiff/`

Suggested first API:

```ts
export type NotebookDiffOptions = {
  includeOutputs?: boolean;
  includeMetadata?: boolean;
  ignoreTransientMetadata?: boolean;
};

export type NotebookDiff = {
  baseLabel?: string;
  compareLabel?: string;
  cells: CellDiff[];
  notebookMetadata?: JsonDiff;
  summary: NotebookDiffSummary;
};

export type CellDiff =
  | UnchangedCellDiff
  | InsertedCellDiff
  | DeletedCellDiff
  | ModifiedCellDiff
  | MovedCellDiff;
```

The implementation should not expose raw JSON patch operations as the primary
UI contract. The UI needs cell-level concepts:

- inserted,
- deleted,
- modified,
- moved,
- unchanged with optional folding,
- source changed,
- outputs changed,
- metadata changed.

Use lower-level text/json diff libraries internally if needed.

V0 should target Runme notebooks only. The diff engine may use a small
normalized internal shape if it keeps the implementation clean, but it does not
need to support imported `.ipynb` notebooks. A Jupyter adapter can be added
later if direct `.ipynb` comparison becomes a product requirement.

### Notebook Normalization

Normalize before diffing:

- clone the proto objects into plain JSON-like structures,
- drop volatile metadata by default,
- normalize missing arrays/maps,
- normalize trailing whitespace according to a documented option,
- decode text-like output payloads where practical,
- replace binary output payloads with stable summaries.

Default ignored metadata should include:

- active process ids,
- last run ids,
- transient execution status,
- fields that only reflect in-progress execution.

Do not ignore authored metadata such as runner selection, language selection, or
cell visibility until we decide whether the user needs to see those changes.

### Cell Matching

Use a tiered matching strategy:

1. Match by `refId` when both notebooks have unique stable refs.
2. Match by exact authored content when `refId` is missing or duplicated.
3. Match by similarity over `kind`, `languageId`, and `value`.
4. Treat remaining cells as insertions/deletions.

Move detection should be best-effort. A cell with the same `refId` but different
index is a move. A moved and edited cell should be represented as both moved and
modified.

Resolved:

- Runme notebook cell `refId` values are durable across save and load.
- Runme should keep `refId` values as stable as possible across import, export,
  copy, and duplicate operations because diff quality depends on stable cell
  identity.
- If an operation would create duplicate `refId` values within one notebook, it
  should regenerate only the copied/inserted cell refs needed to preserve
  per-notebook uniqueness.

### Source Diff

For `value` changes, compute an inline text diff.

Requirements:

- line-level hunks for multi-line code and markdown,
- word-level highlighting within modified lines when cheap enough,
- stable behavior for long cells,
- syntax highlighting for code cells if the renderer already supports it.

Potential implementation choices:

- Use an existing JavaScript diff package for line/word chunks.
- Use Monaco diff editor in read-only mode for expanded source diffs.
- Start with a lightweight line/word diff and revisit Monaco only if needed.

Recommendation for v0:

- Use a lightweight pure TypeScript diff package for the model.
- Render the result with app-owned components.

Reason:

- Monaco is strong for source diff, but notebook diff also needs cell
  insertion, deletion, output, and metadata structure. Putting Monaco at the
  center can make the non-source parts harder to model.

### Output Diff

Output diffs should be enabled by default.

Recommended v0 behavior:

- Always indicate when outputs differ.
- Text outputs: show inline line diffs.
- JSON outputs: pretty-print and diff as text.
- HTML outputs: show source diff first; rendered preview can come later.
- Images and binary outputs: show added/removed/changed summaries based on mime
  type, size, and checksum.
- Stateful Runme terminal/output internals: hide by default.
- Fold large or noisy output bodies by default so output changes do not dominate
  the cell source diff.

Future behavior:

- Render image diffs for matching image mime types.
- Render rich output previews side by side in sandboxed containers.
- Let users toggle "source only", "source + text outputs", and "all outputs".

Resolution behavior:

- Do not merge outputs in V0.
- If a conflict resolution or merge path creates a resolved notebook, clear
  outputs for affected cells.
- Users can rerun cells after resolving authored source and metadata.
- Output-only divergence still counts as a sync conflict. The app should let
  the user decide which notebook state to preserve, even when authored source
  and metadata are unchanged.

Reason:

- Output merge semantics are ill-defined. Outputs are generated artifacts, can
  depend on external state, and may not be reproducible from either side of the
  diff. Clearing outputs is simpler and avoids creating misleading combined
  results.

### Metadata Diff

Metadata should be summarized, not shown as a raw JSON tree by default.

Recommended v0 behavior:

- Hide transient metadata.
- Show user-visible metadata changes as compact badges or an expandable JSON
  section.
- Include metadata changes in the summary count so hidden changes are not
  invisible.

Examples:

- runner changed,
- language changed,
- Jupyter server/kernel selection changed,
- hidden/collapsed state changed.

Design question:

- Which metadata keys should affect notebook diffs, and which should be ignored
  as execution noise?

This matters because notebook metadata mixes two kinds of state:

- Authored user state: configuration that changes notebook behavior or user
  intent, such as runner selection, language/runtime selection, visibility, or
  cell presentation settings.
- Transient execution state: values created while running cells, such as process
  ids, active run ids, exit status, execution sequence, streaming/incomplete
  output markers, and timestamps.

The diff should show authored state because users may need to review or resolve
it. The diff should hide transient execution state by default because it changes
frequently and can make two notebooks look different even when the authored
content is the same.

The decision we need is a concrete allowlist or blocklist:

- Show by default: metadata that affects how the notebook runs or renders.
- Hide by default: metadata that only records a past or in-progress execution.
- Put behind an "advanced metadata" toggle: diagnostic metadata that can be
  useful for debugging but is not normally part of user-authored notebook
  content.

Decision for V0:

- Start with this show/hide/advanced split.
- Treat the exact metadata key lists as implementation details that we can
  refine as we inspect real notebooks.
- Prefer hiding execution noise over showing every possible metadata change.

## Rendering Design

Add a read-only diff route or panel that takes two notebook versions and a
comparison label.

The V0 UI should use a side-by-side notebook diff as the single canonical view:

- diff rows appear in notebook order,
- the base version appears in the left column,
- the compare version appears in the right column,
- inserted cells render with an empty left column and an added right column,
- deleted cells render with a deleted left column and an empty right column,
- modified cells render both versions side by side,
- unchanged cells are collapsed by default across both columns,
- outputs appear below the source for each side when enabled.

Markdown cells should render as source diffs in V0. Do not add a separate
rendered Markdown preview path in the first implementation. Source diff is the
authored state users resolve, and keeping one representation avoids a second
view mode.

Use one viewing mode in V0. Do not build both vertical and side-by-side
renderers.

Reasons:

- It is closer to Colab's comparison model.
- It makes before/after review more direct.
- It avoids spending V0 effort on maintaining two render paths.
- A single canonical view makes testing and user feedback easier.

Simplifications for V0:

- Do not try to perfectly synchronize line heights inside source diffs.
- Use row-level alignment for cells, not pixel-perfect alignment for every
  line.
- Collapse unchanged cells by default.
- Fold outputs by default if they make a row too tall.
- On narrow screens, allow horizontal scrolling instead of introducing a
  separate vertical renderer.
- Do not virtualize diff rows in V0. If very large notebooks are slow, add a
  temporary warning or cap before building virtualization.

Virtualization can become necessary when the diff view tries to mount too many
expensive rows at once:

- notebooks with hundreds or thousands of cells,
- cells with very large source blocks,
- cells with large outputs,
- syntax-highlighted code on both sides,
- markdown preview rendering for many changed cells,
- side-by-side layout measurement across many rows.

Punt on this for V0. The first implementation should optimize for correctness
and simpler rendering. If real notebooks expose performance problems, add
virtualization after the row model stabilizes.

Resolution actions should be out of scope for the first render-only milestone.
When we add them, use whole-cell resolution for V0:

- accept base cell,
- accept compare cell,
- delete cell,
- keep both cells.

Do not offer output merge actions in V0. Resolution should produce authored
notebook state, then clear outputs for the cells touched by resolution.

Do not support source-hunk, metadata-only, or output-subpart resolution in V0.
Those can be added later if whole-cell resolution is too coarse.

## Version and Sync Integration

The initial diff entry points should come from version-aware workflows:

1. Browser-kernel helper: compare current local notebook with an available
   Drive revision.
2. Compare local mirror with upstream version during a sync conflict.
3. Compare current local notebook with an older Drive revision from a UI picker.
4. Compare two saved local snapshots once snapshot history exists.

Google Drive-backed notebooks already track upstream version metadata in
`LocalFileRecord.lastUpstreamVersion`. That metadata can label the two sides of
the diff, but the diff should compare notebook payloads, not revision ids.

Output-only changes should count as sync conflicts. Outputs are part of the
persisted notebook state, so the app should not silently choose local or
upstream output state when they diverge. V0 resolution can still clear outputs
for affected cells rather than trying to merge them.

Open implementation question:

- How do we fetch older Drive revisions in the browser without broadening Drive
  scopes or introducing a backend helper?

Initial answer:

- Use Drive `revisions.list` and `revisions.get(..., alt=media)` for
  Drive-backed blob notebook files.
- Require the browser OAuth credential to include scopes that can read the
  Drive file and its revision history.
- Accept that Drive's revision list can be incomplete and that older blob
  revisions can be purged.

Decision for V0:

- Drive revision fetch should happen in the browser.
- The implementation can assume the active OAuth credential has the required
  Drive scopes to fetch notebook documents and revision contents.
- If the credential lacks scope, the helper should fail with an auth/scope error
  instead of falling back to a backend.

## Proposed Milestones

### Milestone 1: Code-Centric V0

- Add `app/src/lib/notebookDiff/`.
- Add a runtime `notebookDiff` helper namespace.
- Implement `notebookDiff.listDriveRevisions`.
- Implement `notebookDiff.diffDriveRevision`.
- Implement `notebookDiff.openDiffTab`.
- Add a minimal read-only diff route backed by an in-memory diff registry.
- Add one browser-kernel example cell that lists revisions, computes a diff,
  and opens the diff tab.

### Milestone 2: Research and Fixtures

- Capture Colab screenshot examples for added, deleted, edited, moved cells,
  output-only changes, and metadata-only changes.
- Add notebook fixture pairs under `app/test/fixtures/notebooks/diffs/`.
- Add expected `NotebookDiff` JSON snapshots.

### Milestone 3: Pure Diff Model

- Implement normalization.
- Implement cell matching.
- Implement source and text-output diffs.
- Add unit tests for each fixture pair.

### Milestone 4: Read-Only Renderer

- Improve the read-only React diff view.
- Render inserted/deleted/modified cells.
- Fold unchanged cells.
- Add output diff toggles.
- Add browser tests with representative fixtures.

### Milestone 5: Sync Conflict Entry Point

- When sync detects a local/upstream conflict, expose a "Review changes" action.
- Load both versions.
- Open the diff view with local and upstream labels.
- Keep resolution manual in this milestone.

### Milestone 6: Resolution

- Extend the diff model toward three-way decisions.
- Use base/local/remote versions when available.
- Add cell-level accept actions.
- Persist the resolved notebook through `LocalNotebooks`.

## Open Questions

None for V0.

## Recommendation

Build a Runme-native diff model in TypeScript and use `nbdime` as the design
reference.

Do not shell out to `nbdime` or require a Python/Jupyter server in v0. That
would make notebook review depend on an optional runtime and would not fit the
browser-first local mirror architecture.

The model should be intentionally close to notebook concepts rather than a
generic JSON patch. We can add JSON-patch export or `nbdime` compatibility
later if integrations need it.
