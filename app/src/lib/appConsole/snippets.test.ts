import { describe, expect, it } from 'vitest'

import { buildListDriveRevisionsSnippet } from './snippets'

describe('buildListDriveRevisionsSnippet', () => {
  it('opens the notebook and lists its Drive revisions', () => {
    expect(buildListDriveRevisionsSnippet('local://file/abc')).toBe(
      [
        'await notebooks.open("local://file/abc")',
        'await notebookDiff.listDriveRevisions({ uri: "local://file/abc" })',
      ].join('\n')
    )
  })

  it('escapes the URI so it cannot end the string literal early', () => {
    const uri = 'local://file/x");alert(1);("'
    const snippet = buildListDriveRevisionsSnippet(uri)

    // Each interpolated literal must round-trip back to the original URI.
    const literals = snippet.match(/"(?:[^"\\]|\\.)*"/g) ?? []
    expect(literals.map((literal) => JSON.parse(literal))).toEqual([uri, uri])
  })
})
