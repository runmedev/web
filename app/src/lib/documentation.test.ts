import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DOCUMENTATION_MIME_TYPE,
  fetchRemoteMarkdownDocument,
  getGettingStartedDocument,
  isRemoteMarkdownUri,
  listDocumentation,
  resolveDocumentationHref,
  toRawMarkdownUri,
} from './documentation'
import type { RunmeVersionInfo } from './versionInfo'

const versionInfo: RunmeVersionInfo = {
  buildDate: null,
  webRepo: 'runmedev/web',
  webBranch: 'main',
  webCommit: 'abc123def456',
  codexRepo: null,
  codexBranch: null,
  codexCommit: null,
  bucket: null,
}

describe('documentation catalog', () => {
  it('uses commit-pinned GitHub permalinks without bundling document content', () => {
    const documents = listDocumentation(versionInfo)

    expect(documents.length).toBeGreaterThan(10)
    expect(documents[0]).toMatchObject({
      title: 'Getting Started',
      path: 'docs/00-getting-started.md',
      uri: 'https://github.com/runmedev/web/blob/abc123def456/docs/00-getting-started.md',
      rawUri:
        'https://raw.githubusercontent.com/runmedev/web/abc123def456/docs/00-getting-started.md',
      revision: 'abc123def456',
      readOnly: true,
    })
    expect(documents[0]).not.toHaveProperty('content')
    expect(getGettingStartedDocument(versionInfo)).toEqual(documents[0])
  })

  it('publishes every user guide but not the repository index', () => {
    const docsDirectory = resolve(process.cwd(), '../docs')
    const markdownFiles = readdirSync(docsDirectory)
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .map((name) => `docs/${name}`)
      .sort()
    const publishedPaths = listDocumentation(versionInfo)
      .map(({ path }) => path)
      .sort()

    expect(publishedPaths).toEqual(markdownFiles)
  })

  it('requires an exact web commit', () => {
    expect(() =>
      listDocumentation({ ...versionInfo, webCommit: null })
    ).toThrow('does not identify its web commit')
  })

  it('recognizes and resolves Markdown links', () => {
    const base =
      'https://github.com/runmedev/web/blob/abc123/docs/00-getting-started.md'

    expect(isRemoteMarkdownUri(base)).toBe(true)
    expect(isRemoteMarkdownUri('https://example.com/index.html')).toBe(false)
    expect(resolveDocumentationHref('01-next.md', base)).toBe(
      'https://github.com/runmedev/web/blob/abc123/docs/01-next.md'
    )
    expect(toRawMarkdownUri(base)).toBe(
      'https://raw.githubusercontent.com/runmedev/web/abc123/docs/00-getting-started.md'
    )
  })

  it('fetches GitHub Markdown through its raw permalink', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '# Getting Started',
    })) as unknown as typeof fetch
    const uri =
      'https://github.com/runmedev/web/blob/abc123/docs/00-getting-started.md'

    const document = await fetchRemoteMarkdownDocument(uri, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/runmedev/web/abc123/docs/00-getting-started.md',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: expect.any(String) }),
      })
    )
    expect(document).toEqual({
      uri,
      name: '00-getting-started.md',
      mimeType: DOCUMENTATION_MIME_TYPE,
      content: '# Getting Started',
      readOnly: true,
      version: { revisionId: 'abc123' },
    })
  })
})
