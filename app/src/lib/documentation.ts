import { DOCUMENTATION_MANIFEST } from '../generated/documentationManifest'
import { markOnboardingTaskComplete } from './onboarding'
import { type RunmeVersionInfo, runmeVersionInfo } from './versionInfo'

export const DOCUMENTATION_MIME_TYPE = 'text/markdown'
export const GETTING_STARTED_DOCUMENT_PATH = 'docs/00-getting-started.md'
export const GETTING_STARTED_OPENED_STORAGE_KEY =
  'runme/documentation/getting-started-opened'

type DocumentationDefinition = {
  name: string
  description: string
  order: number
  path: string
  title: string
}

export type DocumentationEntry = DocumentationDefinition & {
  uri: string
  rawUri: string
  repository: string
  revision: string
  readOnly: true
}

export type DocumentationSummary = Pick<
  DocumentationDefinition,
  'name' | 'description'
>

export type RemoteMarkdownDocument = {
  uri: string
  name: string
  mimeType: typeof DOCUMENTATION_MIME_TYPE
  content: string
  readOnly: true
  version?: {
    revisionId?: string
  }
}

const BUNDLED_DOCUMENTS = import.meta.glob('../../../docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BUNDLED_IMAGES = import.meta.glob(
  '../../../docs/**/*.{png,jpg,jpeg,svg,webp,gif}',
  { query: '?url', import: 'default', eager: true }
) as Record<string, string>

/** Resolve only this build's documentation. Never substitute another revision. */
function bundledPath(uri: string): string | undefined {
  if (!runmeVersionInfo.webCommit) return undefined
  const repo = normalizeRepository(runmeVersionInfo.webRepo)
  const revision = runmeVersionInfo.webCommit
  const url = new URL(uri)
  const clean = url.origin + url.pathname
  for (const prefix of [
    `https://github.com/${repo}/blob/${revision}/`,
    `https://raw.githubusercontent.com/${repo}/${revision}/`,
  ]) {
    if (clean.startsWith(prefix))
      return decodeURIComponent(clean.slice(prefix.length))
  }
}

const DOCUMENTATION_DEFINITIONS: readonly DocumentationDefinition[] =
  DOCUMENTATION_MANIFEST

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function normalizeRepository(value: string | null): string {
  return value?.trim() || 'runmedev/web'
}

function requireRevision(info: RunmeVersionInfo): string {
  const revision = info.webCommit?.trim()
  if (!revision) {
    throw new Error(
      'Runme documentation is unavailable because this build does not identify its web commit.'
    )
  }
  return revision
}

export function listDocumentation(
  info: RunmeVersionInfo = runmeVersionInfo
): DocumentationEntry[] {
  const repository = normalizeRepository(info.webRepo)
  const revision = requireRevision(info)
  return DOCUMENTATION_DEFINITIONS.map((definition) => {
    const path = encodePath(definition.path)
    return {
      ...definition,
      repository,
      revision,
      uri: `https://github.com/${repository}/blob/${revision}/${path}`,
      rawUri: `https://raw.githubusercontent.com/${repository}/${revision}/${path}`,
      readOnly: true,
    }
  })
}

export function listDocumentationSummaries(
  info: RunmeVersionInfo = runmeVersionInfo
): DocumentationSummary[] {
  return listDocumentation(info).map(({ name, description }) => ({
    name,
    description,
  }))
}

export function getDocumentationEntry(
  name: string,
  info: RunmeVersionInfo = runmeVersionInfo
): DocumentationEntry {
  const normalizedName = typeof name === 'string' ? name.trim() : ''
  const documents = listDocumentation(info)
  const entry = documents.find((candidate) => candidate.name === normalizedName)
  if (!entry) {
    throw new Error(
      `Unknown Runme documentation "${name}". Available names: ${documents
        .map((candidate) => candidate.name)
        .join(', ')}`
    )
  }
  return entry
}

export async function getDocumentationMarkdown(
  name: string,
  info: RunmeVersionInfo = runmeVersionInfo,
  _fetchImpl: typeof fetch = fetch
): Promise<string> {
  const entry = getDocumentationEntry(name, info)
  const content = BUNDLED_DOCUMENTS[`../../../${entry.path}`]
  if (content === undefined)
    throw new Error(`Bundled documentation is missing: ${entry.path}`)
  return stripDocumentationFrontmatter(content)
}

export function getGettingStartedDocument(
  info: RunmeVersionInfo = runmeVersionInfo
): DocumentationEntry {
  const entry = listDocumentation(info).find(
    (candidate) => candidate.path === GETTING_STARTED_DOCUMENT_PATH
  )
  if (!entry) {
    throw new Error('Getting Started documentation is not configured.')
  }
  return entry
}

export function isRemoteMarkdownUri(value: string | null | undefined): boolean {
  if (!value) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.pathname.toLowerCase().endsWith('.md')
    )
  } catch {
    return false
  }
}

export function resolveDocumentationHref(
  href: string,
  baseUri: string
): string {
  const resolved = new URL(href, baseUri).toString()
  const path = bundledPath(resolved)
  const asset = path && BUNDLED_IMAGES[`../../../${path}`]
  return asset ? new URL(asset, window.location.origin).href : resolved
}

export function toRawMarkdownUri(uri: string): string {
  const url = new URL(uri)
  if (url.hostname === 'github.com' && url.pathname.includes('/blob/')) {
    const segments = url.pathname.split('/').filter(Boolean)
    const blobIndex = segments.indexOf('blob')
    if (blobIndex >= 2 && blobIndex + 2 < segments.length) {
      const [owner, repository] = segments
      const revision = segments[blobIndex + 1]
      const path = segments.slice(blobIndex + 2).join('/')
      return `https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${path}`
    }
  }
  return url.toString()
}

function deriveRemoteDocumentName(uri: string): string {
  try {
    const url = new URL(uri)
    return decodeURIComponent(
      url.pathname.split('/').filter(Boolean).pop() || 'documentation.md'
    )
  } catch {
    return 'documentation.md'
  }
}

function getRevisionFromGitHubUri(uri: string): string | undefined {
  try {
    const url = new URL(uri)
    const segments = url.pathname.split('/').filter(Boolean)
    if (url.hostname === 'github.com') {
      const blobIndex = segments.indexOf('blob')
      return blobIndex >= 0 ? segments[blobIndex + 1] : undefined
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      return segments[2]
    }
  } catch {
    // The caller reports the invalid URL.
  }
  return undefined
}

export function stripDocumentationFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:\r?\n)?/, '')
}

export async function fetchRemoteMarkdownDocument(
  uri: string,
  fetchImpl: typeof fetch = fetch
): Promise<RemoteMarkdownDocument> {
  if (!isRemoteMarkdownUri(uri)) {
    throw new Error(
      `Unsupported documentation URI ${uri}. Expected an HTTP(S) Markdown link.`
    )
  }
  // Current-build permalinks are document identities, not network dependencies.
  // Older revisions and user-supplied remote Markdown retain their HTTP behavior.
  // Anchors and query parameters do not change the bytes at a commit-pinned
  // path. Keep those links local too, while preserving the caller's URI.
  const path = bundledPath(uri)
  const bundled = path
    ? listDocumentation().find((entry) => entry.path === path)
    : undefined
  if (bundled) {
    return {
      uri,
      name: deriveRemoteDocumentName(uri),
      mimeType: DOCUMENTATION_MIME_TYPE,
      content: BUNDLED_DOCUMENTS[`../../../${bundled.path}`],
      readOnly: true,
      version: { revisionId: bundled.revision },
    }
  }
  const rawUri = toRawMarkdownUri(uri)
  const response = await fetchImpl(rawUri, {
    headers: {
      Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
    },
  })
  if (!response.ok) {
    throw new Error(
      `Failed to load documentation (${response.status} ${response.statusText}) from ${uri}`
    )
  }
  const revisionId = getRevisionFromGitHubUri(uri)
  const content = await response.text()
  return {
    uri,
    name: deriveRemoteDocumentName(uri),
    mimeType: DOCUMENTATION_MIME_TYPE,
    content,
    readOnly: true,
    ...(revisionId ? { version: { revisionId } } : {}),
  }
}

export function hasOpenedGettingStarted(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    return (
      window.localStorage.getItem(GETTING_STARTED_OPENED_STORAGE_KEY) === 'true'
    )
  } catch {
    return false
  }
}

export function markGettingStartedOpened(): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(GETTING_STARTED_OPENED_STORAGE_KEY, 'true')
  } catch {
    // Opening documentation should not depend on localStorage availability.
  }
}

export function markDocumentationOpened(uri: string): void {
  let gettingStarted: DocumentationEntry
  try {
    gettingStarted = getGettingStartedDocument()
  } catch {
    return
  }
  if (uri === gettingStarted.uri || uri === gettingStarted.rawUri) {
    markGettingStartedOpened()
    markOnboardingTaskComplete('read-getting-started')
  }
}
