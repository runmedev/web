import { getCellTitle } from './cellContent'

function getShareBaseUrl(): URL {
  if (typeof window === 'undefined') {
    throw new Error('Share links are only available in a browser environment')
  }

  return new URL(window.location.pathname, window.location.origin)
}

function extractMarkdownLinkHref(reference: string): string | null {
  const trimmed = reference.trim()
  if (!trimmed.endsWith(')')) {
    return null
  }

  const linkStart = trimmed.lastIndexOf('](')
  if (linkStart < 0 || !trimmed.startsWith('[')) {
    return null
  }

  const href = trimmed.slice(linkStart + 2, -1).trim()
  return href || null
}

function getNotebookLinkText(name: string): string {
  const trimmed = name.trim()
  const withoutJson = trimmed.replace(/\.json$/i, '')
  return withoutJson || trimmed || 'Untitled'
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

export function buildNotebookShareUrl(remoteUri: string): string {
  const trimmed = remoteUri.trim()
  if (!trimmed) {
    throw new Error('A notebook URI is required to build a share link')
  }

  const url = getShareBaseUrl()
  url.searchParams.set('doc', trimmed)
  return url.toString()
}

export function buildNotebookCellShareUrl(
  remoteUri: string,
  cellRefId: string
): string {
  return `${buildNotebookShareUrl(remoteUri)}${buildNotebookCellFragment(
    cellRefId
  )}`
}

export function buildNotebookCellFragment(cellRefId: string): string {
  const trimmedCellRefId = cellRefId.trim()
  if (!trimmedCellRefId) {
    throw new Error('A cell reference ID is required to build a cell link')
  }

  return `#cell=${encodeURIComponent(trimmedCellRefId)}`
}

export function parseNotebookCellFragment(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!fragment.startsWith('cell=')) {
    return null
  }

  try {
    return decodeURIComponent(fragment.slice('cell='.length)) || null
  } catch {
    return fragment.slice('cell='.length) || null
  }
}

export type NotebookShareLinkTarget = {
  notebookUri: string
  cellRefId: string | null
}

const RUNME_GATEWAY_HOSTNAME =
  /^runme\.gateway\.unified-\d+\.internal\.api\.openai\.org$/i

function isKnownRunmeAppHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === 'web.runme.dev' ||
    normalized.endsWith('.web.runme.dev') ||
    RUNME_GATEWAY_HOSTNAME.test(normalized)
  )
}

function canOpenNotebookShareLinkInCurrentApp(
  url: URL,
  browserUrl: URL
): boolean {
  return (
    url.origin === browserUrl.origin ||
    (isKnownRunmeAppHostname(url.hostname) &&
      isKnownRunmeAppHostname(browserUrl.hostname))
  )
}

export function parseNotebookShareLink(
  href: string,
  baseUrl?: string
): NotebookShareLinkTarget | null {
  const trimmed = href.trim()
  if (!trimmed) {
    return null
  }

  const browserBaseUrl =
    baseUrl ??
    (typeof window === 'undefined' ? undefined : window.location.href)

  try {
    const url = browserBaseUrl
      ? new URL(trimmed, browserBaseUrl)
      : new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    if (
      browserBaseUrl &&
      !canOpenNotebookShareLinkInCurrentApp(url, new URL(browserBaseUrl))
    ) {
      return null
    }
    const notebookUri = url.searchParams.get('doc')?.trim()
    if (!notebookUri) {
      return null
    }
    return {
      notebookUri,
      cellRefId: parseNotebookCellFragment(url.hash),
    }
  } catch {
    return null
  }
}

export function buildNotebookMarkdownLink(
  name: string,
  remoteUri: string
): string {
  const linkText = escapeMarkdownLinkText(getNotebookLinkText(name))
  return `[${linkText}](${buildNotebookShareUrl(remoteUri)})`
}

export function buildNotebookCellMarkdownLink(
  name: string,
  cellValue: string,
  remoteUri: string,
  cellRefId: string
): string {
  const linkText = escapeMarkdownLinkText(
    `${getNotebookLinkText(name)}#${getCellTitle(cellValue)}`
  )
  return `[${linkText}](${buildNotebookCellShareUrl(remoteUri, cellRefId)})`
}

export async function copyNotebookShareUrl(remoteUri: string): Promise<string> {
  if (
    typeof window === 'undefined' ||
    !window.navigator?.clipboard?.writeText
  ) {
    throw new Error('Clipboard access is unavailable in this browser')
  }

  const shareUrl = buildNotebookShareUrl(remoteUri)
  await window.navigator.clipboard.writeText(shareUrl)
  return shareUrl
}

export async function copyNotebookCellShareUrl(
  remoteUri: string,
  cellRefId: string
): Promise<string> {
  if (
    typeof window === 'undefined' ||
    !window.navigator?.clipboard?.writeText
  ) {
    throw new Error('Clipboard access is unavailable in this browser')
  }

  const shareUrl = buildNotebookCellShareUrl(remoteUri, cellRefId)
  await window.navigator.clipboard.writeText(shareUrl)
  return shareUrl
}

export async function copyNotebookCellMarkdownLink(
  name: string,
  cellValue: string,
  remoteUri: string,
  cellRefId: string
): Promise<string> {
  if (
    typeof window === 'undefined' ||
    !window.navigator?.clipboard?.writeText
  ) {
    throw new Error('Clipboard access is unavailable in this browser')
  }

  const markdownLink = buildNotebookCellMarkdownLink(
    name,
    cellValue,
    remoteUri,
    cellRefId
  )
  await window.navigator.clipboard.writeText(markdownLink)
  return markdownLink
}

export async function copyNotebookMarkdownLink(
  name: string,
  remoteUri: string
): Promise<string> {
  if (
    typeof window === 'undefined' ||
    !window.navigator?.clipboard?.writeText
  ) {
    throw new Error('Clipboard access is unavailable in this browser')
  }

  const markdownLink = buildNotebookMarkdownLink(name, remoteUri)
  await window.navigator.clipboard.writeText(markdownLink)
  return markdownLink
}

export function buildNotebookShareBaseUrl(): string {
  return getShareBaseUrl().toString()
}

export function getNotebookShareTarget(
  localUri: string | undefined,
  remoteUri?: string | null
): string {
  const trimmedRemote = remoteUri?.trim()
  if (trimmedRemote) {
    return trimmedRemote
  }
  const trimmedLocal = localUri?.trim()
  if (!trimmedLocal) {
    throw new Error('A notebook URI is required to build a share target')
  }
  return trimmedLocal
}

export function normalizeNotebookReferenceUri(reference: string): string {
  const href = extractMarkdownLinkHref(reference) ?? reference
  const trimmed = href.trim()
  if (!trimmed) {
    throw new Error('A notebook reference is required')
  }

  try {
    const url = new URL(trimmed)
    const doc = url.searchParams.get('doc')?.trim()
    if (doc) {
      return doc
    }
  } catch {
    // Not a URL; return the trimmed local/fs/Drive reference as-is.
  }

  return trimmed
}
