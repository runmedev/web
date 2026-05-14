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
existing trusted rendering path already used for `text/html` cell outputs.

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

HTML preview is trusted-but-contained content.

We will render the preview with:

- `iframe`
- `srcDoc={cell.value}`
- `sandbox="allow-scripts"`

This matches the existing rendering path for `text/html` cell outputs.

Rationale:

- It isolates CSS and DOM from the notebook shell.
- It lets inline SVG work naturally.
- It avoids `dangerouslySetInnerHTML` in the main React tree.

This is intentionally different from markdown:

- markdown remains a constrained authoring surface,
- html is an explicit raw-content mode with a visibly different trust boundary.

This proposal does not add `allow-same-origin` or message-passing from the
preview back into the app.

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
