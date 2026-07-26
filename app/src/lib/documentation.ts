import { markOnboardingTaskComplete } from './onboarding'
import { type RunmeVersionInfo, runmeVersionInfo } from './versionInfo'

export const DOCUMENTATION_MIME_TYPE = 'text/markdown'
export const GETTING_STARTED_DOCUMENT_PATH = 'docs/00-getting-started.md'
export const GETTING_STARTED_OPENED_STORAGE_KEY =
  'runme/documentation/getting-started-opened'

type DocumentationDefinition = {
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

const DOCUMENTATION_DEFINITIONS: readonly DocumentationDefinition[] = [
  { path: GETTING_STARTED_DOCUMENT_PATH, title: 'Getting Started' },
  {
    path: 'docs/01-editing-and-running-cells.md',
    title: 'Editing And Running Cells',
  },
  { path: 'docs/02-workspace-explorer.md', title: 'Workspace Explorer' },
  {
    path: 'docs/03-local-notebooks-and-browser-storage.md',
    title: 'Local Notebooks And Browser Storage',
  },
  {
    path: 'docs/04-filesystem-workspaces.md',
    title: 'Filesystem Workspaces',
  },
  {
    path: 'docs/05-google-drive-integration.md',
    title: 'Google Drive Integration',
  },
  {
    path: 'docs/06-sharing-and-opening-drive-links.md',
    title: 'Sharing And Opening Drive Links',
  },
  { path: 'docs/07-runners-overview.md', title: 'Runners Overview' },
  {
    path: 'docs/08-local-runme-runners.md',
    title: 'Local Runme Runners',
  },
  {
    path: 'docs/09-appkernel-browser-runners.md',
    title: 'AppKernel Browser Runners',
  },
  { path: 'docs/10-jupyter-runners.md', title: 'Jupyter Runners' },
  {
    path: 'docs/11-webmcp-external-control.md',
    title: 'WebMCP External Control',
  },
  {
    path: 'docs/13-app-console-reference.md',
    title: 'App Console Reference',
  },
  {
    path: 'docs/14-authentication-and-app-configuration.md',
    title: 'Authentication And App Configuration',
  },
  {
    path: 'docs/15-logs-diagnostics-and-troubleshooting.md',
    title: 'Logs Diagnostics And Troubleshooting',
  },
  { path: 'docs/16-notebook-diffs.md', title: 'Notebook Diffs' },
  { path: 'docs/README.md', title: 'Documentation Index' },
]

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
  return new URL(href, baseUri).toString()
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

export async function fetchRemoteMarkdownDocument(
  uri: string,
  fetchImpl: typeof fetch = fetch
): Promise<RemoteMarkdownDocument> {
  if (!isRemoteMarkdownUri(uri)) {
    throw new Error(
      `Unsupported documentation URI ${uri}. Expected an HTTP(S) Markdown link.`
    )
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
  return {
    uri,
    name: deriveRemoteDocumentName(uri),
    mimeType: DOCUMENTATION_MIME_TYPE,
    content: await response.text(),
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
