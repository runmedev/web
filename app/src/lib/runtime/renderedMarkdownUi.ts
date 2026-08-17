import { parser_pb } from '../../runme/client'
import {
  RENDERED_MARKDOWN_PROJECTION_NAME,
  RENDERED_MARKDOWN_PROJECTION_VERSION,
  type RenderedMarkdownProjection,
  type RenderedMarkdownSelectionDraft,
  type TextPositionSelector,
  type TextQuoteSelector,
  buildRenderedMarkdownProjection,
  captureRenderedMarkdownSelection,
  sliceByCodePoint,
} from '../markdown/renderedMarkdownProjection'
import type { NotebookDataLike } from './runmeConsole'

export type RenderedMarkdownUiTarget = { uri: string }
export type RenderedMarkdownUiSelector =
  | TextPositionSelector
  | TextQuoteSelector

export type SelectRenderedMarkdownRequest = {
  target: RenderedMarkdownUiTarget
  cellId: string
  selector: RenderedMarkdownUiSelector
}

export type OpenRenderedMarkdownContextMenuRequest = {
  target: RenderedMarkdownUiTarget
  cellId: string
  anchor?: 'selection'
}

type SelectionContext = {
  root: HTMLElement
  source: string
  projection: RenderedMarkdownProjection
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`)
  }
  return value
}

function findRenderedRoot(notebookUri: string, cellId: string): HTMLElement {
  const panels = Array.from(
    document.querySelectorAll<HTMLElement>('[data-document-id]')
  ).filter((panel) => panel.dataset.documentId === notebookUri)
  const activePanels = panels.filter(
    (panel) => panel.dataset.state === 'active'
  )
  const panel =
    activePanels.length === 1
      ? activePanels[0]
      : panels.length === 1
        ? panels[0]
        : null
  if (!panel) {
    throw new Error(
      panels.length === 0
        ? `The active notebook (${notebookUri}) is not rendered in the document.`
        : `The active notebook (${notebookUri}) is ambiguous in the document.`
    )
  }
  const roots = Array.from(
    panel.querySelectorAll<HTMLElement>('[data-runme-cell-id]')
  )
  const matches = roots.filter((root) => root.dataset.runmeCellId === cellId)
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Rendered Markdown cell ${cellId} is not visible. Render the cell before selecting it.`
        : `Rendered Markdown cell ${cellId} is ambiguous in the current document.`
    )
  }
  const root = matches[0]
  const expectedProjection = `${RENDERED_MARKDOWN_PROJECTION_NAME}@${RENDERED_MARKDOWN_PROJECTION_VERSION}`
  if (
    root.dataset.runmeSurface !== 'rendered-markdown' ||
    root.dataset.runmeProjection !== expectedProjection
  ) {
    throw new Error(
      `Cell ${cellId} is not using the supported rendered Markdown projection.`
    )
  }
  return root
}

function resolveContext(
  getCurrentNotebook: () => NotebookDataLike | null,
  request: {
    target: RenderedMarkdownUiTarget
    cellId: string
  }
): SelectionContext {
  const requestedUri = requireString(request.target?.uri, 'target.uri')
  const cellId = requireString(request.cellId, 'cellId')
  const current = getCurrentNotebook()
  if (!current) {
    throw new Error('No notebook is active in the Runme UI.')
  }
  if (current.getUri() !== requestedUri) {
    throw new Error(
      `The requested notebook (${requestedUri}) is not the active notebook (${current.getUri()}).`
    )
  }
  const cell = current
    .getNotebook()
    .cells.find((candidate) => candidate.refId === cellId)
  if (!cell) {
    throw new Error(`Cell ${cellId} does not exist in the active notebook.`)
  }
  if (cell.kind !== parser_pb.CellKind.MARKUP) {
    throw new Error(`Cell ${cellId} is not a Markdown cell.`)
  }
  return {
    root: findRenderedRoot(requestedUri, cellId),
    source: cell.value,
    projection: buildRenderedMarkdownProjection(cell.value),
  }
}

function resolveQuoteSelector(
  projection: RenderedMarkdownProjection,
  selector: TextQuoteSelector
): TextPositionSelector {
  const exact = requireString(selector.exact, 'selector.exact')
  const matches: number[] = []
  let utf16Index = projection.text.indexOf(exact)
  while (utf16Index >= 0) {
    const prefixMatches =
      selector.prefix === undefined ||
      projection.text.slice(
        Math.max(0, utf16Index - selector.prefix.length),
        utf16Index
      ) === selector.prefix
    const endUtf16 = utf16Index + exact.length
    const suffixMatches =
      selector.suffix === undefined ||
      projection.text.slice(endUtf16, endUtf16 + selector.suffix.length) ===
        selector.suffix
    if (prefixMatches && suffixMatches) {
      matches.push(utf16Index)
    }
    utf16Index = projection.text.indexOf(exact, utf16Index + 1)
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'The TextQuoteSelector did not match the rendered Markdown projection.'
        : 'The TextQuoteSelector is ambiguous; add prefix and/or suffix context.'
    )
  }
  const startUtf16 = matches[0]
  return {
    type: 'TextPositionSelector',
    start: Array.from(projection.text.slice(0, startUtf16)).length,
    end: Array.from(projection.text.slice(0, startUtf16 + exact.length)).length,
  }
}

function resolvePositionSelector(
  projection: RenderedMarkdownProjection,
  selector: RenderedMarkdownUiSelector
): TextPositionSelector {
  const resolved =
    selector.type === 'TextQuoteSelector'
      ? resolveQuoteSelector(projection, selector)
      : selector
  const length = Array.from(projection.text).length
  if (
    !Number.isInteger(resolved.start) ||
    !Number.isInteger(resolved.end) ||
    resolved.start < 0 ||
    resolved.start >= resolved.end ||
    resolved.end > length
  ) {
    throw new Error(
      `TextPositionSelector must satisfy 0 <= start < end <= ${length}.`
    )
  }
  return resolved
}

function mappedText(span: HTMLElement): Text {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
  const text = walker.nextNode()
  if (!(text instanceof Text)) {
    throw new Error('Rendered Markdown projection span has no text node.')
  }
  return text
}

function codePointOffsetToUtf16Offset(value: string, offset: number): number {
  return Array.from(value).slice(0, offset).join('').length
}

function boundaryForProjectionOffset(
  root: HTMLElement,
  projection: RenderedMarkdownProjection,
  offset: number,
  direction: 'start' | 'end'
): { node: Text; utf16Offset: number } {
  const spans = Array.from(
    root.querySelectorAll<HTMLElement>('[data-runme-projection-start]')
  )
  for (const span of spans) {
    const start = Number(span.dataset.runmeProjectionStart)
    const end = Number(span.dataset.runmeProjectionEnd)
    const contains =
      direction === 'start'
        ? start <= offset && offset < end
        : start < offset && offset <= end
    if (!Number.isInteger(start) || !Number.isInteger(end) || !contains) {
      continue
    }
    const node = mappedText(span)
    const expected = sliceByCodePoint(projection.text, start, end)
    if (node.data !== expected) {
      throw new Error(
        'Rendered Markdown DOM is stale relative to the active notebook.'
      )
    }
    return {
      node,
      utf16Offset: codePointOffsetToUtf16Offset(node.data, offset - start),
    }
  }
  throw new Error(
    `Projection offset ${offset} does not map to rendered Markdown text.`
  )
}

function createRangeForSelector(
  context: SelectionContext,
  selector: RenderedMarkdownUiSelector
): Range {
  const position = resolvePositionSelector(context.projection, selector)
  const start = boundaryForProjectionOffset(
    context.root,
    context.projection,
    position.start,
    'start'
  )
  const end = boundaryForProjectionOffset(
    context.root,
    context.projection,
    position.end,
    'end'
  )
  const range = document.createRange()
  range.setStart(start.node, start.utf16Offset)
  range.setEnd(end.node, end.utf16Offset)
  return range
}

function currentSelectionDraft(
  context: SelectionContext,
  cellId: string
): RenderedMarkdownSelectionDraft {
  const selection = document.getSelection()
  if (!selection) {
    throw new Error('The browser Selection API is unavailable.')
  }
  const draft = captureRenderedMarkdownSelection({
    root: context.root,
    selection,
    cellId,
    source: context.source,
    projection: context.projection,
  })
  if (!draft) {
    throw new Error(
      'The active browser selection is not a valid rendered Markdown range.'
    )
  }
  return draft
}

function publicSelectionResult(draft: RenderedMarkdownSelectionDraft) {
  return {
    type: draft.type,
    cellId: draft.cellId,
    surface: draft.surface,
    projection: {
      name: draft.projection.name,
      version: draft.projection.version,
    },
    selectors: draft.selectors,
    sourceHints: draft.sourceHints,
  }
}

async function afterReactEvent(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export function createRenderedMarkdownUiApi({
  getCurrentNotebook,
}: {
  getCurrentNotebook: () => NotebookDataLike | null
}) {
  const selectRenderedMarkdown = (request: SelectRenderedMarkdownRequest) => {
    const context = resolveContext(getCurrentNotebook, request)
    const range = createRangeForSelector(context, request.selector)
    const selection = document.getSelection()
    if (!selection) {
      throw new Error('The browser Selection API is unavailable.')
    }
    selection.removeAllRanges()
    selection.addRange(range)
    return publicSelectionResult(currentSelectionDraft(context, request.cellId))
  }

  const openContextMenu = async (
    request: OpenRenderedMarkdownContextMenuRequest
  ) => {
    if (request.anchor !== undefined && request.anchor !== 'selection') {
      throw new Error(
        'ui.openContextMenu currently supports anchor: "selection" only.'
      )
    }
    const context = resolveContext(getCurrentNotebook, request)
    const draft = currentSelectionDraft(context, request.cellId)
    const range = document.getSelection()?.getRangeAt(0)
    if (!range) {
      throw new Error('The browser selection has no range.')
    }
    const rect = range.getBoundingClientRect()
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
    })
    context.root.dispatchEvent(event)
    await afterReactEvent()
    if (!event.defaultPrevented) {
      throw new Error(
        'Runme did not accept the rendered Markdown context-menu event. Comments may be unavailable.'
      )
    }
    const panel = context.root.closest<HTMLElement>('[data-document-id]')
    const menus = Array.from(
      panel?.querySelectorAll<HTMLElement>(
        '[data-runme-context-menu-cell-id]'
      ) ?? []
    )
    const menu = menus.find(
      (candidate) => candidate.dataset.runmeContextMenuCellId === request.cellId
    )
    if (!menu || menu.dataset.runmeContextMenuKind !== 'rendered-selection') {
      throw new Error('The rendered-selection context menu did not open.')
    }
    const action = menu.querySelector<HTMLElement>(
      '[data-runme-context-menu-action="comment-selection"]'
    )
    if (!action) {
      throw new Error('The rendered-selection comment action is unavailable.')
    }
    return {
      opened: true,
      defaultPrevented: true,
      cellId: request.cellId,
      action: 'comment-selection' as const,
      ...publicSelectionResult(draft),
    }
  }

  return {
    selectRenderedMarkdown,
    openContextMenu,
    prepareRenderedComment: async (request: SelectRenderedMarkdownRequest) => {
      selectRenderedMarkdown(request)
      return openContextMenu({
        target: request.target,
        cellId: request.cellId,
        anchor: 'selection',
      })
    },
    clearSelection: () => {
      const selection = document.getSelection()
      const previousRangeCount = selection?.rangeCount ?? 0
      selection?.removeAllRanges()
      return {
        cleared: true,
        previousRangeCount,
        rangeCount: selection?.rangeCount ?? 0,
        isCollapsed: selection?.isCollapsed ?? true,
      }
    },
    help: () =>
      [
        'ui.selectRenderedMarkdown({ target: { uri }, cellId, selector })',
        'ui.openContextMenu({ target: { uri }, cellId, anchor: "selection" })',
        'ui.prepareRenderedComment({ target: { uri }, cellId, selector })',
        'ui.clearSelection()',
        'Selectors are W3C-style TextQuoteSelector or TextPositionSelector objects over the rendered Markdown projection.',
      ].join('\n'),
  }
}
