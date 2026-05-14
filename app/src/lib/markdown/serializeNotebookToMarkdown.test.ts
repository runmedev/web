import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import { MimeType, parser_pb } from '../../runme/client'
import { serializeNotebookToMarkdown } from './serializeNotebookToMarkdown'

const textEncoder = new TextEncoder()

describe('serializeNotebookToMarkdown', () => {
  it('renders markdown cells, code cells, and text outputs', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: '# Title\n\nSome notes.',
        }),
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: 'print("hello")',
          outputs: [
            create(parser_pb.CellOutputSchema, {
              items: [
                create(parser_pb.CellOutputItemSchema, {
                  mime: MimeType.VSCodeNotebookStdOut,
                  type: 'Buffer',
                  data: textEncoder.encode('hello\n'),
                }),
                create(parser_pb.CellOutputItemSchema, {
                  mime: 'application/json',
                  type: 'Buffer',
                  data: textEncoder.encode('{"ok":true}'),
                }),
              ],
            }),
          ],
        }),
      ],
    })

    expect(serializeNotebookToMarkdown(notebook)).toBe(
      [
        '# Title',
        '',
        'Some notes.',
        '',
        '```python',
        'print("hello")',
        '```',
        '',
        '```stdout',
        'hello',
        '```',
        '',
        '```json',
        '{"ok":true}',
        '```',
        '',
      ].join('\n')
    )
  })

  it('treats code cells tagged as markdown as prose', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'markdown',
          value: 'A paragraph with **bold** text.',
        }),
      ],
    })

    expect(serializeNotebookToMarkdown(notebook)).toBe(
      'A paragraph with **bold** text.\n'
    )
  })

  it('serializes html cells as authored content instead of fenced code', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'html',
          value: '<div><svg><text>Hello</text></svg></div>',
        }),
      ],
    })

    expect(serializeNotebookToMarkdown(notebook)).toBe(
      '<div><svg><text>Hello</text></svg></div>\n'
    )
  })

  it('skips binary and internal output payloads', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'bash',
          value: 'echo hi',
          outputs: [
            create(parser_pb.CellOutputSchema, {
              items: [
                create(parser_pb.CellOutputItemSchema, {
                  mime: MimeType.StatefulRunmeTerminal,
                  type: 'Buffer',
                  data: textEncoder.encode('ignored'),
                }),
                create(parser_pb.CellOutputItemSchema, {
                  mime: 'image/png',
                  type: 'Buffer',
                  data: new Uint8Array([0, 1, 2, 3]),
                }),
                create(parser_pb.CellOutputItemSchema, {
                  mime: MimeType.VSCodeNotebookStdErr,
                  type: 'Buffer',
                  data: textEncoder.encode('warn\n'),
                }),
              ],
            }),
          ],
        }),
      ],
    })

    expect(serializeNotebookToMarkdown(notebook)).toBe(
      ['```bash', 'echo hi', '```', '', '```stderr', 'warn', '```', ''].join(
        '\n'
      )
    )
  })

  it('uses a longer fence when content already contains triple backticks', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'javascript',
          value: 'console.log("```inside```")',
        }),
      ],
    })

    expect(serializeNotebookToMarkdown(notebook)).toBe(
      ['````javascript', 'console.log("```inside```")', '````', ''].join('\n')
    )
  })
})
