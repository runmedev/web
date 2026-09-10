# Read notebooks containing wide Markdown and outputs

Regression: a wide table, code block, or output expands Radix's fit-content
wrapper and makes every paragraph wrap beyond the visible pane.

## Design decisions

- The viewport owns notebook width. Constrain Radix's generated inner wrapper
  to 100% width and max-width, scoped to `.notebook-scroll-area`. `w-full` on
  the notebook alone refers to the already expanded wrapper and cannot fix it.
- The notebook scrolls vertically. Horizontal scrolling belongs to individual
  tables and fenced code blocks, with keyboard-focusable scroll regions.
- Prose, links, inline identifiers and plain-text outputs use `overflow-wrap:
  anywhere`. Unlike `break-word`, it also reduces intrinsic minimum width.
- Tables use normal wrapping so wide columns stay readable and scroll locally.
  Fenced code preserves whitespace; the `pre`, not a second nested `code`
  scroller, owns overflow. Do not clip content to conceal a sizing regression.
- Scope the unlayered CSS override to notebook panes; other Radix scroll areas,
  including the tab rail and review panels, keep their existing behavior.
- Restoring active-cell focus must preserve a focused descendant. Otherwise
  activating a cell steals focus from its table/code scroller and prevents
  the first keyboard scroll. Test this with a previously inactive cell.

Full design and before/after evidence:
[20260910_horizontal_rendering.runme](https://runme.gateway.unified-0.internal.api.openai.org/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1m4Zx1EPXjrrXKYdzgXBhTatI5nYLj-ES%2Fview).

## Fixture and acceptance criteria

`app/test/fixtures/notebooks/horizontal-rendering.json` includes ordinary prose,
a two-column table, long inline code, a long fenced command, a 12-column table,
a long stored output URL, and a sibling Markdown cell. It contains no real
incident data or service credentials and needs no backend execution.

Run `test-scenario-horizontal-rendering.ts` through the canonical CUJ runner.
At 1280px and 900px browser widths, require:

1. Notebook column and scroll width do not exceed the viewport (1px tolerance).
2. Paragraphs fit and wrap; the small table fits.
3. Wide table and code block overflow locally, with keyboard focus available.
4. Long output remains intact and wraps within its output panel.
5. The sibling cell is present; earlier wide content does not expand the column.

Record measurements, screenshots and video under `app/test/browser/test-output/`.
Also inspect the wide blocks after scrolling locally and test resizing with
Explorer/Comments panels open. A CSS-class test in jsdom cannot establish these
layout properties; use browser geometry and inspect screenshots.
