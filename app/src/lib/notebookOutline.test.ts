import { describe, expect, it } from 'vitest'

import { parser_pb } from '../contexts/CellContext'
import { extractNotebookOutline } from './notebookOutline'

function markupCell(refId: string, value: string) {
  return {
    kind: parser_pb.CellKind.MARKUP,
    languageId: 'markdown',
    refId,
    value,
  }
}

describe('extractNotebookOutline', () => {
  it('extracts ATX and Setext headings in notebook order', () => {
    const outline = extractNotebookOutline([
      markupCell(
        'cell-one',
        '# Title\n\n## Section ##\n\nSetext section\n---\n\n###### Detail'
      ),
      markupCell('cell-two', 'Another title\n==='),
    ])

    expect(outline).toEqual([
      { cellRefId: 'cell-one', level: 1, line: 1, text: 'Title' },
      { cellRefId: 'cell-one', level: 2, line: 3, text: 'Section' },
      { cellRefId: 'cell-one', level: 2, line: 5, text: 'Setext section' },
      { cellRefId: 'cell-one', level: 6, line: 8, text: 'Detail' },
      { cellRefId: 'cell-two', level: 1, line: 1, text: 'Another title' },
    ])
  })

  it('ignores heading-like text in fenced code blocks', () => {
    const outline = extractNotebookOutline([
      markupCell(
        'cell-one',
        '# Visible\n\n```markdown\n# Hidden\n````\n\n~~~\n## Also hidden\n~~~\n\n## Visible too'
      ),
    ])

    expect(outline.map((entry) => entry.text)).toEqual([
      'Visible',
      'Visible too',
    ])
  })

  it('ignores code cells and accepts markup cells without a language id', () => {
    const outline = extractNotebookOutline([
      {
        kind: parser_pb.CellKind.CODE,
        languageId: 'markdown',
        refId: 'code-cell',
        value: '# Not a markup cell',
      },
      {
        kind: parser_pb.CellKind.MARKUP,
        languageId: '',
        refId: 'legacy-markup-cell',
        value: '# Legacy markup',
      },
      markupCell('empty', 'No headings here.'),
    ])

    expect(outline).toEqual([
      {
        cellRefId: 'legacy-markup-cell',
        level: 1,
        line: 1,
        text: 'Legacy markup',
      },
    ])
  })
})
