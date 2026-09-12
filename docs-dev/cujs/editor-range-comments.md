# Comment on a source range in Monaco

## User journey

In a `.runme` notebook, select part of a code cell or a Markdown cell in edit
mode. Right-click and choose **Comment on selection**, or press
**Ctrl+Alt+M** (**Cmd+Option+M** on macOS). The comments panel shows the selected
source. Enter a comment and submit it. Empty selections do not offer this action.

The existing cell comment button continues to comment on the whole cell.
Rendered Markdown keeps its existing selection menu. Legacy JSON/ipynb files use
their existing comment flow; this source-range action requires `.runme` revision
history.

## Design decisions that prevent regressions

- Monaco owns selection coordinates. Read its current model and normalized
  selection synchronously when the action runs; a browser DOM selection cannot
  represent editor source reliably and may disappear when a menu takes focus.
- Monaco offsets use UTF-16. Pass them to the existing operation-log anchor
  binder, which validates source boundaries and converts them to Unicode code
  points. Never persist Monaco offsets directly: emoji otherwise shift ranges.
- Flush pending notebook edits and bind to immutable cell source when the draft
  opens. Submission uses that bound revision. Later edits or syncs may mark the
  anchor outdated, but must not move it to different text or reject a valid
  previously captured revision.
- Selected source is transient draft data for display/validation. The durable
  comment stores the revision and source range; historical context is resolved
  from that revision, not from a captured quote or a checksum of current text.
- Preserve source draft whitespace so newlines and indentation remain visible.
  Verify browser geometry and computed whitespace, not only `textContent`.
- Store the optional `selection_surface` with typed anchors to preserve the UI
  origin across reloads. `surface: source` always describes storage coordinates;
  it must not be used to infer editor versus rendered navigation. Older V2
  comments lack this hint and keep rendered navigation, except comparison
  comments: their comparison context identifies a source selection. New diff
  comments explicitly store the source hint. Project mapped source
  ranges into the current rendered text for scrolling; never use source offsets
  directly as rendered offsets.
- Persisted source ranges navigate to Monaco and activate only their own thread.
  A compatibility anchor shaped like a whole-cell comment still contains a typed
  source range; inspect those historical locations when grouping/activating cards.
- Source drafts retain the `editor` focus role even in a Markdown wrapper.
  Switching tabs or restoring window focus must return to source editing.
- Register/dispose the Monaco action with its current callback and comment
  availability. Memoization must not retain a stale cell callback or hide newly
  available comments. Keep Monaco's context menu from also opening the outer
  cell menu.

## Automated evidence

`app/test/browser/test-scenario-editor-range-comments.ts` is registered in the
canonical CUJ suite. It creates a local `.runme` fixture and uses real keyboard
input to select multiline ranges containing emoji. It submits a code comment
through Monaco's menu and a Markdown source comment through the shortcut, edits
Markdown after draft capture, and reloads the page. Assertions verify exact
selected excerpts, immutable Unicode ranges, original source, and both persisted
comments. Screenshots cover the menu, submitted comments, and reloaded notebook;
the JSON artifact records persisted anchors and the movie shows the walkthrough.

Unit tests cover live model capture, empty selections, callback replacement and
action disposal. Store-backed component tests cover all three selection surfaces
(rendered Markdown, code, Markdown source), pending saves, and later sync edits.

## Whole-document comments

The comment bubble immediately left of **Review suggestions** opens a **New
comment on notebook** draft in `.runme` notebooks, including empty notebooks.
It uses a `notebook` anchor bound to the revision visible when the draft opens;
it must never infer a cell or range from focus or selection. The button is
disabled for read-only notebooks, while submitting, and while another draft is
open so a repeated click cannot discard text. Submit also checks writability.

The browser journey verifies button order, the absence of a selected-text quote,
and a durable notebook anchor after reload. Evidence is in
`scenario-whole-document-comment-{draft,saved}.png` and
`scenario-whole-document-comment.json`. Component tests cover empty notebooks,
read-only gating, draft preservation, and retaining the original revision after
later edits. Existing cell and range workflows remain covered by the same CUJ.
