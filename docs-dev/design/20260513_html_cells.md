# 2026-05-13: HTML Cells

## Status

Proposed and implemented in this branch.

## Summary

Add an `html` notebook cell mode that behaves like the existing markdown cell
mode:

- edit mode shows the raw HTML source in Monaco,
- render mode previews the result in place,
- the cell does not execute through a runner,
- switching between source and preview is local UI behavior, not notebook
  execution.

We will represent HTML cells as existing `CODE` cells with
`languageId: "html"`.

We will not introduce a new protobuf `CellKind`.

The rendered preview will use a sandboxed `iframe` with `srcDoc`, matching the
existing trusted rendering path already used for `text/html` cell outputs, but
with stricter script handling for authored cell content.

## Motivation

Today a user can render HTML or SVG in a notebook only indirectly:

- code cells can emit `text/html` or `image/svg+xml` output bundles,
- markdown cells render prose in place, but raw HTML is intentionally disabled
  in the editable notebook UI.

That leaves a product gap for authored rich content:

- users cannot paste HTML or inline SVG as notebook source and preview it
  directly,
- the only current workaround is a runnable cell that emits the markup as
  output,
- that is heavier than necessary when the content is static or illustrative.

An explicit HTML cell addresses that gap without weakening markdown safety.

## Goals

- Let users author HTML directly in notebook cells.
- Support inline SVG through HTML source such as `<svg>...</svg>`.
- Preserve the markdown cell trust model. Markdown remains sanitized and does
  not render raw HTML in the main notebook editor.
- Avoid schema changes to the notebook protobuf model.
- Reuse the existing HTML preview trust boundary where possible.
- Keep HTML cells visible in source form when notebooks are serialized to
  Markdown sidecars.

## Non-Goals

- Executing HTML cells through Runme runners, Jupyter, or AppKernel.
- Adding a general-purpose raw-HTML mode to markdown cells.
- Adding a separate `svg` cell type.
- Building a full HTML document editor with assets, dependency management, or a
  live dev server.
- Introducing cross-cell scripting or access from preview iframes back into the
  app shell.

## Current State

The existing notebook UI has two relevant behaviors.

Markdown cells:

- use `CellKind.MARKUP` or `languageId=markdown`,
- render in place with `react-markdown`,
- explicitly disable raw HTML in the editable notebook experience.

Code cells:

- render Monaco source,
- may show rich outputs below the source,
- already render `text/html` outputs inside a sandboxed `iframe srcDoc`.

The existing notebook data model also hard-codes markup cells to markdown.

That means the cleanest way to add HTML authoring is not to repurpose
`CellKind.MARKUP`, but to recognize `languageId=html` as a notebook-native
non-executing authored-content mode.

## Decision

We are choosing Option B:

1. Represent HTML cells as `CellKind.CODE` with `languageId: "html"`.
2. Add a dedicated in-place `HtmlCell` component with edit/render behavior
   parallel to `MarkdownCell`.
3. Render the preview through a sandboxed `iframe srcDoc`.
4. Treat HTML cells as non-runnable content cells in the notebook UI.
5. Serialize HTML cells into Markdown sidecars as raw HTML, not fenced code.
6. In the first version, do not allow scripts in authored HTML previews.
7. Gate execution on both `kind` and `languageId`, so `languageId=html` is
   skipped by notebook execution APIs.

## Why Reuse `CODE` + `languageId=html`

Reasons:

- No protobuf/schema migration is required.
- Existing notebook APIs and storage already preserve arbitrary code
  `languageId` values.
- Monaco already understands `html`.
- Language switching can convert between `markdown`, `html`, and runnable code
  languages without inventing a third structural cell kind.
- It keeps the meaning explicit: markdown is markup prose, html is raw trusted
  DOM content.

We explicitly do not reuse `CellKind.MARKUP` for HTML, because that kind is
already semantically and programmatically tied to markdown behavior across the
app.

## UX

### Authoring

HTML cells should feel like markdown cells:

- empty HTML cells start in edit mode,
- non-empty HTML cells start in rendered mode,
- double-click rendered preview enters edit mode,
- `Esc` or blur returns to preview when non-empty,
- `Shift+Enter` or the editor's existing run gesture should preview rather than
  execute.

Edit mode uses Monaco with `language="html"`.

### Language switching

The language selector should add `HTML`.

Conversions:

- `markdown` -> `html`
  - convert to `CellKind.CODE`
  - set `languageId` to `html`
- `html` -> runnable language
  - keep `CellKind.CODE`
  - change `languageId`
  - clear runner/kernel metadata as needed
- runnable language -> `html`
  - keep `CellKind.CODE`
  - set `languageId` to `html`
  - clear runner/kernel metadata

We keep `markdown` special because it still maps to `CellKind.MARKUP`.

### Empty notebook affordance

The existing "add first cell" button currently creates a markdown cell.

We will keep that behavior. HTML is an opt-in language choice, not the default
for new notebooks.

## Rendering and Security

HTML preview is contained content, but it should not be treated as trusted by
default.

We will render the preview with:

- `iframe`
- `srcDoc={cell.value}`
- `sandbox` with no `allow-scripts` token in the first version

This is intentionally stricter than the current `text/html` output path.

Rationale:

- It isolates CSS and DOM from the notebook shell.
- It lets inline SVG work naturally.
- It avoids `dangerouslySetInnerHTML` in the main React tree.
- It still supports the immediate HTML-cell use case of static HTML, CSS, and
  inline SVG.
- It avoids automatically executing JavaScript just by opening a notebook.

This is intentionally different from markdown:

- markdown remains a constrained authoring surface,
- html is an explicit raw-content mode with a visibly different trust boundary.

This proposal does not add `allow-same-origin` or message-passing from the
preview back into the app.

### Future trust model

Longer term, we should add an explicit notebook trust model instead of treating
all HTML cells the same.

Recommended direction:

- notebooks opened from local disk, Drive, or shared links start untrusted,
- untrusted notebooks render HTML cells with scripts disabled,
- users can explicitly mark a notebook trusted,
- trusted notebooks may opt into richer preview capabilities, including script
  execution, if product demand justifies it.

The closest existing precedent is Jupyter's notebook trust model. JupyterLab's
current user docs say that JavaScript and HTML from notebooks created on other
machines are not trusted by default, that interactive outputs are blocked until
the notebook is explicitly trusted, and that markdown cells are always
sanitized. The classic Notebook security docs make the same distinction: for
untrusted notebooks, HTML is sanitized, JavaScript is not executed, and users
can explicitly trust a notebook later.

Sources:

- [JupyterLab user docs: Trust](https://jupyterlab.readthedocs.io/en/stable/user/notebook.html#trust)
- [Jupyter Notebook security docs](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)

We do not need to build Jupyter's full signature-based trust model in the first
HTML-cell iteration, but its policy shape is a useful reference:

- safe default on open,
- explicit upgrade to trusted,
- no raw HTML/JS execution in markdown.

## Notebook Serialization

Markdown sidecars currently serialize:

- markdown cells as prose,
- code cells as fenced code blocks.

HTML cells are authored content, not executable source, so fenced-code output is
the wrong projection for search/readability.

We will serialize HTML cells as raw HTML text with trailing whitespace trimmed,
similar to how markdown cells are emitted directly.

Consequences:

- Drive sidecars remain readable.
- Search can index text inside HTML and SVG source.
- An exported sidecar keeps a faithful authored representation.

We are not trying to sanitize or pretty-print the HTML during serialization.

## Read-Only Notebook Views

Any read-only notebook presentation that currently distinguishes only between
code and markdown should also recognize `languageId=html`.

For those views, HTML cells should render as authored content instead of showing
only a code block.

That keeps shared/opened notebooks consistent with the main editor experience.

For the first version, read-only views should use the same no-scripts preview
policy as the editable notebook view. Opening a shared notebook should not
execute authored JavaScript automatically.

## Execution Semantics

HTML cells are stored as `CellKind.CODE` for compatibility, but they are not
semantically runnable code cells.

Short-term recommendation:

- keep `CellKind.CODE` plus `languageId=html`,
- treat `languageId=html` as a non-runnable subtype everywhere execution is
  dispatched,
- gate execution on both cell kind and normalized language, not cell kind
  alone.

That means at minimum:

- the per-cell editor should not show run affordances for HTML cells,
- `runme.runAll()` should skip HTML cells,
- `notebooks.execute({ target, refIds })` should skip or reject HTML cells
  explicitly,
- any future bulk execution helper should follow the same rule.

Why this is the right short-term tradeoff:

- it avoids a schema migration,
- it keeps language-switching simple,
- it preserves the existing storage model,
- it prevents accidental execution of raw markup through shell, Jupyter, or
  AppKernel paths.

If we later find that `kind=CODE` creates too much branching or ambiguity, we
can revisit a dedicated protobuf kind. That should be a follow-on cleanup, not a
prerequisite for the initial feature.

## Testing

Required coverage:

1. Unit tests for notebook cell language switching.
2. Unit tests for notebook serialization of HTML cells.
3. UI tests for rendering/editing behavior where practical in JSDOM.
4. Browser scenario validation that:
   - creates or opens a notebook,
   - switches a cell to HTML,
   - enters HTML containing inline SVG,
   - exits edit mode,
   - verifies the preview renders expected text/SVG markers,
   - records a `.webm` walkthrough.
5. Execution-path tests proving that HTML cells are skipped by `runAll` and
   rejected or ignored by `notebooks.execute(...)`.
6. Trust-boundary tests proving that authored scripts do not run in HTML cell
   previews in the first version.

## Alternatives Considered

### Option A: Enable raw HTML in markdown cells

Rejected.

Reasons:

- It weakens the markdown safety model.
- It mixes two trust levels into one cell type.
- It makes it harder for users to understand whether a cell is prose or raw
  DOM content.

### Option B: New protobuf `CellKind.HTML`

Rejected for now.

Reasons:

- Requires schema and compatibility work with little immediate benefit.
- The existing `languageId` field already provides enough expressiveness.

### Option C: SVG-only cells

Rejected.

Reasons:

- HTML already covers inline SVG.
- A separate SVG-only mode creates unnecessary surface area.

## Rollout Notes

This design is intentionally minimal.

If we later find strong demand for richer embedded documents, we can extend the
preview shell with:

- default sizing helpers,
- resize affordances,
- safer preview metadata,
- optional source formatting.

Those are follow-on improvements, not prerequisites for the first HTML cell
feature.
