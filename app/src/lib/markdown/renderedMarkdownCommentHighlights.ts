import { renderedMarkdownDomRange } from './renderedMarkdownProjection'

export const COMMENT_HIGHLIGHT_NAME = 'runme-comment-range'
export const ACTIVE_COMMENT_HIGHLIGHT_NAME = 'runme-comment-range-active'

export type RenderedMarkdownCommentRange = {
  start: number
  end: number
  active?: boolean
}

type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}

type HighlightConstructor = new (...ranges: Range[]) => unknown

const owners = new Map<
  object,
  { regular: Range[]; active: Range[]; root: HTMLElement }
>()

function highlightApi(): {
  registry: HighlightRegistry
  Highlight: HighlightConstructor
} | null {
  const registry =
    typeof CSS === 'undefined'
      ? undefined
      : (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights
  const Highlight = (
    globalThis as typeof globalThis & { Highlight?: HighlightConstructor }
  ).Highlight
  return registry && Highlight ? { registry, Highlight } : null
}

function rebuildHighlights() {
  const api = highlightApi()
  if (!api) {
    return false
  }
  const regular = Array.from(owners.values()).flatMap((entry) => entry.regular)
  const active = Array.from(owners.values()).flatMap((entry) => entry.active)
  if (regular.length > 0) {
    api.registry.set(COMMENT_HIGHLIGHT_NAME, new api.Highlight(...regular))
  } else {
    api.registry.delete(COMMENT_HIGHLIGHT_NAME)
  }
  if (active.length > 0) {
    api.registry.set(
      ACTIVE_COMMENT_HIGHLIGHT_NAME,
      new api.Highlight(...active)
    )
  } else {
    api.registry.delete(ACTIVE_COMMENT_HIGHLIGHT_NAME)
  }
  return true
}

function clearFallback(root: HTMLElement) {
  root
    .querySelectorAll<HTMLElement>('[data-runme-comment-highlight]')
    .forEach((span) => delete span.dataset.runmeCommentHighlight)
}

function applyFallback(
  root: HTMLElement,
  ranges: readonly RenderedMarkdownCommentRange[]
) {
  clearFallback(root)
  root
    .querySelectorAll<HTMLElement>('[data-runme-projection-start]')
    .forEach((span) => {
      const spanStart = Number(span.dataset.runmeProjectionStart)
      const spanEnd = Number(span.dataset.runmeProjectionEnd)
      const overlapping = ranges.filter(
        (range) => spanEnd > range.start && spanStart < range.end
      )
      if (overlapping.length === 0) {
        return
      }
      span.dataset.runmeCommentHighlight = overlapping.some(
        (range) => range.active
      )
        ? 'active'
        : 'true'
    })
}

/**
 * Register the exact rendered ranges for one mounted Markdown cell. Modern
 * browsers use the CSS Custom Highlight API; the data-attribute fallback keeps
 * comments visible in browsers that do not expose that API.
 */
export function registerRenderedMarkdownCommentHighlights(
  owner: object,
  root: HTMLElement,
  ranges: readonly RenderedMarkdownCommentRange[]
): () => void {
  const regular: Range[] = []
  const active: Range[] = []
  ranges.forEach((range) => {
    const domRange = renderedMarkdownDomRange(root, range.start, range.end)
    if (!domRange) {
      return
    }
    ;(range.active ? active : regular).push(domRange)
  })
  owners.set(owner, { regular, active, root })
  const nativeHighlights = rebuildHighlights()
  if (nativeHighlights) {
    clearFallback(root)
  } else {
    applyFallback(root, ranges)
  }
  const view = root.ownerDocument.defaultView
  const frame = view?.requestAnimationFrame(() => {
    if (nativeHighlights) {
      rebuildHighlights()
    } else {
      // React Markdown can replace its projected text spans once more after
      // the parent layout effect. Reapply the fallback to the settled DOM.
      applyFallback(root, ranges)
    }
  })

  return () => {
    if (frame !== undefined) {
      view?.cancelAnimationFrame(frame)
    }
    clearFallback(root)
    owners.delete(owner)
    rebuildHighlights()
  }
}
