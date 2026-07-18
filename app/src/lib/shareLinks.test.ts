import { describe, expect, it } from 'vitest'

import {
  buildNotebookCellFragment,
  buildNotebookCellShareUrl,
  buildNotebookMarkdownLink,
  buildNotebookShareBaseUrl,
  buildNotebookShareUrl,
  getNotebookShareTarget,
  normalizeNotebookReferenceUri,
  parseNotebookCellFragment,
} from './shareLinks'

describe('buildNotebookShareUrl', () => {
  it('builds a share URL from the current app location', () => {
    window.history.replaceState(
      null,
      '',
      '/workspace?foo=bar#ignore-this-fragment'
    )

    expect(
      buildNotebookShareUrl(
        'https://drive.google.com/file/d/shared-file-123/view'
      )
    ).toBe(
      'http://localhost:3000/workspace?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Fshared-file-123%2Fview'
    )
  })

  it('throws when the remote URI is empty', () => {
    expect(() => buildNotebookShareUrl('   ')).toThrow(
      'A notebook URI is required to build a share link'
    )
  })
})

describe('notebook cell links', () => {
  it('builds a share URL with an encoded cell ref ID fragment', () => {
    window.history.replaceState(null, '', '/workspace?foo=bar#old-cell')

    expect(
      buildNotebookCellShareUrl(
        'https://drive.google.com/file/d/shared-file-123/view',
        'cell/with spaces'
      )
    ).toBe(
      'http://localhost:3000/workspace?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Fshared-file-123%2Fview#cell=cell%2Fwith%20spaces'
    )
  })

  it('builds a canonical namespaced fragment', () => {
    expect(buildNotebookCellFragment('cell/with spaces')).toBe(
      '#cell=cell%2Fwith%20spaces'
    )
  })

  it('rejects an empty cell ref ID', () => {
    expect(() =>
      buildNotebookCellShareUrl('local://file/notebook', '  ')
    ).toThrow('A cell reference ID is required to build a cell link')
  })

  it('decodes cell fragments and tolerates malformed encoding', () => {
    expect(parseNotebookCellFragment('#cell=cell%2Fwith%20spaces')).toBe(
      'cell/with spaces'
    )
    expect(parseNotebookCellFragment('#cell=bad%2')).toBe('bad%2')
    expect(parseNotebookCellFragment('#cell=')).toBeNull()
    expect(parseNotebookCellFragment('')).toBeNull()
  })

  it('ignores bare and other named fragments', () => {
    expect(parseNotebookCellFragment('#legacy%2Fcell')).toBeNull()
    expect(parseNotebookCellFragment('#access_token=secret')).toBeNull()
    expect(parseNotebookCellFragment('#section=overview')).toBeNull()
  })
})

describe('buildNotebookShareBaseUrl', () => {
  it('returns the app path without query params or fragments', () => {
    window.history.replaceState(null, '', '/workspace?foo=bar#frag')

    expect(buildNotebookShareBaseUrl()).toBe('http://localhost:3000/workspace')
  })
})

describe('getNotebookShareTarget', () => {
  it('prefers the remote URI when one is available', () => {
    expect(
      getNotebookShareTarget(
        'local://file/local-id',
        'https://drive.google.com/file/d/file123/view'
      )
    ).toBe('https://drive.google.com/file/d/file123/view')
  })

  it('falls back to the local URI for local-only notebooks', () => {
    expect(getNotebookShareTarget('local://file/local-id')).toBe(
      'local://file/local-id'
    )
  })
})

describe('buildNotebookMarkdownLink', () => {
  it('builds markdown with the notebook title and app share URL', () => {
    window.history.replaceState(null, '', '/')

    expect(
      buildNotebookMarkdownLink(
        '202602a_tb_aws_codex_136.json',
        'https://drive.google.com/file/d/1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV/view'
      )
    ).toBe(
      '[202602a_tb_aws_codex_136](http://localhost:3000/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV%2Fview)'
    )
  })

  it('escapes markdown link text', () => {
    window.history.replaceState(null, '', '/')

    expect(
      buildNotebookMarkdownLink(
        String.raw`notebook \[draft].json`,
        'https://drive.google.com/file/d/file123/view'
      )
    ).toBe(
      String.raw`[notebook \\[draft\]](http://localhost:3000/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Ffile123%2Fview)`
    )
  })
})

describe('normalizeNotebookReferenceUri', () => {
  it('returns local URIs unchanged', () => {
    expect(
      normalizeNotebookReferenceUri(
        ' local://file/cb1c8a9f-6dad-4e1a-9cbc-467ddebc3018 '
      )
    ).toBe('local://file/cb1c8a9f-6dad-4e1a-9cbc-467ddebc3018')
  })

  it('extracts the doc query param from a Runme share URL', () => {
    expect(
      normalizeNotebookReferenceUri(
        'https://runme.gateway.unified-0.internal.api.openai.org/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F149JKKTgljRiwszwb06Ms74GOYhCOPMNg%2Fview'
      )
    ).toBe(
      'https://drive.google.com/file/d/149JKKTgljRiwszwb06Ms74GOYhCOPMNg/view'
    )
  })

  it('extracts the href from Markdown links before resolving', () => {
    expect(
      normalizeNotebookReferenceUri(
        '[https://drive.google.com/file/d/149JKKTgljRiwszwb06Ms74GOYhCOPMNg/view](https://drive.google.com/file/d/149JKKTgljRiwszwb06Ms74GOYhCOPMNg/view)'
      )
    ).toBe(
      'https://drive.google.com/file/d/149JKKTgljRiwszwb06Ms74GOYhCOPMNg/view'
    )
  })
})
