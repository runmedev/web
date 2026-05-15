const MARKDOWN_LANGUAGE_IDS = new Set(["markdown", "md"]);
const HTML_LANGUAGE_IDS = new Set(["html", "htm"]);

export function isMarkdownLanguageId(languageId?: string | null): boolean {
  return MARKDOWN_LANGUAGE_IDS.has((languageId ?? "").trim().toLowerCase());
}

export function isHtmlLanguageId(languageId?: string | null): boolean {
  return HTML_LANGUAGE_IDS.has((languageId ?? "").trim().toLowerCase());
}
