const MARKDOWN_LANGUAGE_IDS = new Set(['markdown', 'md'])
const HTML_LANGUAGE_IDS = new Set(['html', 'htm'])

/**
 * Derives a user-facing title from the cell's first non-empty line.
 * Repeated Markdown heading (`#`) and line-comment (`//`) prefixes are removed;
 * cells without remaining text use a stable fallback.
 */
export function getCellTitle(value: string): string {
  const firstContentLine =
    value
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ''
  const withoutLeadingMarker = firstContentLine
    .replace(/^(?:(?:#{1,6}|\/\/+)\s*)+/, '')
    .trim()

  return withoutLeadingMarker || 'Untitled cell'
}

export function isMarkdownLanguageId(languageId?: string | null): boolean {
  return MARKDOWN_LANGUAGE_IDS.has((languageId ?? '').trim().toLowerCase())
}

export function isHtmlLanguageId(languageId?: string | null): boolean {
  return HTML_LANGUAGE_IDS.has((languageId ?? '').trim().toLowerCase())
}
