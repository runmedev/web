import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

export const RENDERED_MARKDOWN_PROJECTION_NAME = 'runme-markdown-text'
export const RENDERED_MARKDOWN_PROJECTION_VERSION = 1

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
])

const IGNORED_TAGS = new Set(['button', 'input', 'script', 'style'])

type HastPosition = {
  start?: { offset?: number }
  end?: { offset?: number }
}

type HastNode = {
  type?: string
  tagName?: string
  value?: string
  position?: HastPosition
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export type TextRange = {
  start: number
  end: number
}

export type RenderedMarkdownProjectionSegment = {
  projectionStart: number
  projectionEnd: number
  sourceRanges: TextRange[]
}

export type RenderedMarkdownProjection = {
  name: typeof RENDERED_MARKDOWN_PROJECTION_NAME
  version: typeof RENDERED_MARKDOWN_PROJECTION_VERSION
  text: string
  segments: RenderedMarkdownProjectionSegment[]
}

export type TextPositionSelector = {
  type: 'TextPositionSelector'
  start: number
  end: number
}

export type TextQuoteSelector = {
  type: 'TextQuoteSelector'
  exact: string
  prefix?: string
  suffix?: string
}

export type RenderedMarkdownSelectionDraft = {
  type: 'cell-text'
  cellId: string
  surface: 'rendered-markdown'
  source: string
  projection: RenderedMarkdownProjection
  selectors: [TextPositionSelector, TextQuoteSelector]
  sourceHints: TextRange[]
}

function codePoints(value: string): string[] {
  return Array.from(value)
}

export function sliceByCodePoint(
  value: string,
  start: number,
  end: number
): string {
  return codePoints(value).slice(start, end).join('')
}

export function utf16OffsetToCodePointOffset(
  value: string,
  utf16Offset: number
): number {
  if (utf16Offset < 0 || utf16Offset > value.length) {
    throw new Error(`UTF-16 offset ${utf16Offset} is outside the text node.`)
  }
  const prefix = value.slice(0, utf16Offset)
  const last = prefix.charCodeAt(prefix.length - 1)
  const next = value.charCodeAt(utf16Offset)
  if (
    Number.isFinite(last) &&
    Number.isFinite(next) &&
    last >= 0xd800 &&
    last <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  ) {
    throw new Error('Selection endpoint splits a Unicode surrogate pair.')
  }
  return codePoints(prefix).length
}

function sourceRange(node: HastNode): TextRange[] {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  return typeof start === 'number' && typeof end === 'number' && end >= start
    ? [{ start, end }]
    : []
}

function appendSeparator(chunks: string[]): boolean {
  if (chunks.length === 0) {
    return false
  }
  if (!chunks[chunks.length - 1]?.endsWith('\n')) {
    chunks.push('\n')
    return true
  }
  return false
}

function annotateTextNode(
  node: HastNode,
  segment: RenderedMarkdownProjectionSegment
): HastNode {
  const source = segment.sourceRanges[0]
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      'data-runme-projection-start': String(segment.projectionStart),
      'data-runme-projection-end': String(segment.projectionEnd),
      ...(source
        ? {
            'data-runme-source-start': String(source.start),
            'data-runme-source-end': String(source.end),
          }
        : {}),
    },
    position: node.position,
    children: [node],
  }
}

function projectHast(
  root: HastNode,
  options?: { annotate?: boolean }
): RenderedMarkdownProjection {
  const chunks: string[] = []
  const segments: RenderedMarkdownProjectionSegment[] = []
  let projectionLength = 0

  const appendText = (
    value: string,
    node: HastNode,
    parent?: HastNode,
    childIndex?: number
  ) => {
    if (!value) {
      return
    }
    const start = projectionLength
    projectionLength += codePoints(value).length
    chunks.push(value)
    const segment = {
      projectionStart: start,
      projectionEnd: projectionLength,
      sourceRanges: sourceRange(node),
    }
    segments.push(segment)
    if (options?.annotate && parent?.children && childIndex !== undefined) {
      parent.children[childIndex] = annotateTextNode(node, segment)
    }
  }

  const walk = (node: HastNode, parent?: HastNode, childIndex?: number) => {
    if (node.type === 'text') {
      appendText(node.value ?? '', node, parent, childIndex)
      return
    }
    if (node.type !== 'root' && node.type !== 'element') {
      return
    }

    const tagName = node.tagName?.toLowerCase()
    if (tagName && IGNORED_TAGS.has(tagName)) {
      return
    }
    if (tagName === 'br' || tagName === 'hr') {
      if (appendSeparator(chunks)) {
        projectionLength += 1
      }
      return
    }
    if (tagName === 'img') {
      appendText(String(node.properties?.alt ?? ''), node, parent, childIndex)
      return
    }

    if (tagName && BLOCK_TAGS.has(tagName)) {
      if (appendSeparator(chunks)) {
        projectionLength += 1
      }
    }
    const children = node.children ?? []
    children.forEach((child, index) => walk(child, node, index))
    if (tagName && BLOCK_TAGS.has(tagName)) {
      if (appendSeparator(chunks)) {
        projectionLength += 1
      }
    }
  }

  walk(root)
  const untrimmedText = chunks.join('')
  const text = untrimmedText.replace(/^\n+|\n+$/g, '')
  const leadingTrim = untrimmedText.match(/^\n+/)?.[0].length ?? 0
  if (leadingTrim > 0) {
    for (const segment of segments) {
      segment.projectionStart -= leadingTrim
      segment.projectionEnd -= leadingTrim
    }
  }
  return {
    name: RENDERED_MARKDOWN_PROJECTION_NAME,
    version: RENDERED_MARKDOWN_PROJECTION_VERSION,
    text,
    segments,
  }
}

function parseMarkdownToHast(source: string): HastNode {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype)
  return processor.runSync(processor.parse(source)) as HastNode
}

export function buildRenderedMarkdownProjection(
  source: string
): RenderedMarkdownProjection {
  return projectHast(parseMarkdownToHast(source))
}

export function createRenderedMarkdownProjectionPlugin(
  onProjection: (projection: RenderedMarkdownProjection) => void
): () => (tree: HastNode) => void {
  return () => (tree: HastNode) => {
    onProjection(projectHast(tree, { annotate: true }))
  }
}

function closestProjectionSpan(
  node: Node,
  root: HTMLElement
): HTMLElement | null {
  const element =
    node instanceof Element
      ? node
      : node.parentNode instanceof Element
        ? node.parentNode
        : null
  const span = element?.closest<HTMLElement>('[data-runme-projection-start]')
  return span && root.contains(span) ? span : null
}

function mappedText(span: HTMLElement): Text | null {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
  return walker.nextNode() as Text | null
}

function boundarySpan(
  container: Node,
  offset: number,
  root: HTMLElement,
  direction: 'start' | 'end'
): { span: HTMLElement; utf16Offset: number } | null {
  const direct = closestProjectionSpan(container, root)
  if (direct) {
    const text = mappedText(direct)
    if (!text) {
      return null
    }
    const elementOffset =
      container === direct
        ? offset <= 0
          ? 0
          : text.data.length
        : direction === 'start'
          ? 0
          : text.data.length
    return {
      span: direct,
      utf16Offset:
        container.nodeType === Node.TEXT_NODE ? offset : elementOffset,
    }
  }
  if (!(container instanceof Element)) {
    return null
  }
  const child =
    direction === 'start'
      ? (container.childNodes[offset] ?? null)
      : (container.childNodes[Math.max(0, offset - 1)] ?? null)
  if (!child) {
    return null
  }
  let candidate: HTMLElement | null = null
  if (child instanceof HTMLElement) {
    if (child.matches('[data-runme-projection-start]')) {
      candidate = child
    } else if (direction === 'start') {
      candidate = child.querySelector<HTMLElement>(
        '[data-runme-projection-start]'
      )
    } else {
      candidate =
        Array.from(
          child.querySelectorAll<HTMLElement>('[data-runme-projection-start]')
        ).at(-1) ?? null
    }
  } else {
    candidate = closestProjectionSpan(child, root)
  }
  if (!candidate || !root.contains(candidate)) {
    return null
  }
  const text = mappedText(candidate)
  if (!text) {
    return null
  }
  return {
    span: candidate,
    utf16Offset: direction === 'start' ? 0 : text.data.length,
  }
}

function projectionOffset(boundary: {
  span: HTMLElement
  utf16Offset: number
}): number {
  const start = Number(boundary.span.dataset.runmeProjectionStart)
  const text = mappedText(boundary.span)
  if (!Number.isInteger(start) || !text) {
    throw new Error(
      'Rendered Markdown selection has invalid projection metadata.'
    )
  }
  return start + utf16OffsetToCodePointOffset(text.data, boundary.utf16Offset)
}

function areGraphemeBoundaries(
  value: string,
  offsets: readonly number[]
): boolean {
  const requestedOffsets = [...new Set(offsets)].sort((a, b) => a - b)
  if (
    requestedOffsets.some((offset) => !Number.isInteger(offset) || offset < 0)
  ) {
    return false
  }

  const utf16Offsets = new Map<number, number>()
  let codePointOffset = 0
  let utf16Offset = 0
  let requestedIndex = 0
  while (requestedOffsets[requestedIndex] === 0) {
    utf16Offsets.set(0, 0)
    requestedIndex += 1
  }
  for (const symbol of value) {
    if (requestedIndex >= requestedOffsets.length) {
      break
    }
    utf16Offset += symbol.length
    codePointOffset += 1
    while (requestedOffsets[requestedIndex] === codePointOffset) {
      utf16Offsets.set(codePointOffset, utf16Offset)
      requestedIndex += 1
    }
  }
  if (requestedIndex < requestedOffsets.length) {
    return false
  }

  type Segment = { index: number }
  type SegmenterConstructor = new (
    locales?: string | string[],
    options?: { granularity: 'grapheme' }
  ) => { segment(input: string): Iterable<Segment> }
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor })
    .Segmenter
  if (typeof Segmenter !== 'function') {
    return true
  }

  const pending = new Set(utf16Offsets.values())
  pending.delete(value.length)
  if (pending.size === 0) {
    return true
  }
  for (const segment of new Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(value)) {
    pending.delete(segment.index)
    if (pending.size === 0) {
      return true
    }
  }
  return false
}

export function sourceRangesForProjectionRange(
  projection: RenderedMarkdownProjection,
  source: string,
  start: number,
  end: number
): TextRange[] {
  const ranges = projection.segments.flatMap((segment) => {
    const { projectionStart, projectionEnd } = segment
    if (projectionEnd <= start || projectionStart >= end) {
      return []
    }
    return segment.sourceRanges.map(
      ({ start: sourceStart, end: sourceEnd }) => {
        const overlapStart = Math.max(start, projectionStart)
        const overlapEnd = Math.min(end, projectionEnd)
        const renderedText = sliceByCodePoint(
          projection.text,
          projectionStart,
          projectionEnd
        )
        const sourceText = source.slice(sourceStart, sourceEnd)
        if (renderedText === sourceText) {
          const relativeStart = overlapStart - projectionStart
          const relativeEnd = overlapEnd - projectionStart
          return {
            start:
              sourceStart +
              codePoints(renderedText).slice(0, relativeStart).join('').length,
            end:
              sourceStart +
              codePoints(renderedText).slice(0, relativeEnd).join('').length,
          }
        }
        return { start: sourceStart, end: sourceEnd }
      }
    )
  })
  return ranges.filter(
    (range, index) =>
      index === 0 ||
      range.start !== ranges[index - 1]?.start ||
      range.end !== ranges[index - 1]?.end
  )
}

export function captureRenderedMarkdownSelection(args: {
  root: HTMLElement
  selection: Selection
  cellId: string
  source: string
  projection: RenderedMarkdownProjection
}): RenderedMarkdownSelectionDraft | null {
  const { root, selection, cellId, source, projection } = args
  if (selection.rangeCount !== 1 || selection.isCollapsed) {
    return null
  }
  return captureRenderedMarkdownRange({
    root,
    range: selection.getRangeAt(0),
    cellId,
    source,
    projection,
  })
}

export function captureRenderedMarkdownRange(args: {
  root: HTMLElement
  range: Range
  cellId: string
  source: string
  projection: RenderedMarkdownProjection
}): RenderedMarkdownSelectionDraft | null {
  const { root, range, cellId, source, projection } = args
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null
  }
  const startBoundary = boundarySpan(
    range.startContainer,
    range.startOffset,
    root,
    'start'
  )
  const endBoundary = boundarySpan(
    range.endContainer,
    range.endOffset,
    root,
    'end'
  )
  if (!startBoundary || !endBoundary) {
    return null
  }
  const start = projectionOffset(startBoundary)
  const end = projectionOffset(endBoundary)
  if (start >= end || !areGraphemeBoundaries(projection.text, [start, end])) {
    return null
  }
  const exact = sliceByCodePoint(projection.text, start, end)
  if (!exact) {
    return null
  }
  const prefix = sliceByCodePoint(
    projection.text,
    Math.max(0, start - 32),
    start
  )
  const suffix = sliceByCodePoint(
    projection.text,
    end,
    Math.min(codePoints(projection.text).length, end + 32)
  )
  return {
    type: 'cell-text',
    cellId,
    surface: 'rendered-markdown',
    source,
    projection,
    selectors: [
      { type: 'TextPositionSelector', start, end },
      {
        type: 'TextQuoteSelector',
        exact,
        ...(prefix ? { prefix } : {}),
        ...(suffix ? { suffix } : {}),
      },
    ],
    sourceHints: sourceRangesForProjectionRange(projection, source, start, end),
  }
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
