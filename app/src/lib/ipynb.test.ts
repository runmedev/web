/// <reference types="vitest" />
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  IPYNB_CELL_ID_METADATA_KEY,
  IPYNB_RAW_CELL_METADATA_KEY,
  decodeIpynb,
  encodeIpynb,
} from './ipynb'

const sourceNotebook = {
  cells: [
    {
      cell_type: 'markdown',
      id: 'intro',
      metadata: { tags: ['docs'], vendor: { folded: true } },
      source: ['# Hello\n', 'world'],
      attachments: {
        'pixel.png': { 'image/png': 'AA==' },
      },
    },
    {
      cell_type: 'raw',
      id: 'raw-cell',
      metadata: { format: 'text/plain' },
      source: 'raw payload',
    },
    {
      cell_type: 'code',
      id: 'code-cell',
      metadata: { trusted: true, custom: 42 },
      execution_count: 7,
      source: ['print("hello")\n'],
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: ['hello\n'],
        },
        {
          output_type: 'display_data',
          data: {
            'text/plain': ['a value'],
            'application/json': { answer: 42 },
          },
          metadata: { isolated: true },
        },
      ],
    },
  ],
  metadata: {
    kernelspec: {
      display_name: 'Python 3',
      language: 'python',
      name: 'python3',
    },
    custom_notebook_metadata: { keep: 'me' },
  },
  nbformat: 4,
  nbformat_minor: 5,
}

describe('ipynb codec', () => {
  it('uses a Runme notebook internally and preserves Jupyter-only fields', () => {
    const text = `${JSON.stringify(sourceNotebook, null, 2)}\n`
    const decoded = decodeIpynb(text)

    expect(decoded.notebook.cells).toHaveLength(3)
    expect(decoded.notebook.cells[0]?.value).toBe('# Hello\nworld')
    expect(
      decoded.notebook.cells[1]?.metadata?.[IPYNB_RAW_CELL_METADATA_KEY]
    ).toBe('true')
    expect(
      decoded.notebook.cells[2]?.metadata?.[IPYNB_CELL_ID_METADATA_KEY]
    ).toBe('code-cell')
    expect(decoded.notebook.cells[2]?.outputs).toHaveLength(2)

    decoded.notebook.cells[2]!.value = 'print("edited")\n'
    const encoded = encodeIpynb(decoded.notebook, text, decoded)
    const roundTripped = JSON.parse(encoded.text)

    expect(roundTripped.cells[0].attachments).toEqual(
      sourceNotebook.cells[0].attachments
    )
    expect(roundTripped.cells[0].metadata).toMatchObject(
      sourceNotebook.cells[0].metadata
    )
    expect(roundTripped.cells[1].cell_type).toBe('raw')
    expect(roundTripped.cells[2].metadata).toMatchObject(
      sourceNotebook.cells[2].metadata
    )
    expect(roundTripped.cells[2].source).toBe('print("edited")\n')
    expect(roundTripped.cells[2].outputs).toEqual(
      sourceNotebook.cells[2].outputs
    )
    expect(roundTripped.metadata).toMatchObject(sourceNotebook.metadata)
  })

  it('repairs duplicate and invalid cell ids without losing cell metadata', () => {
    const input = structuredClone(sourceNotebook)
    input.cells[0]!.id = 'invalid id'
    input.cells[1]!.id = 'invalid id'

    const decoded = decodeIpynb(JSON.stringify(input))
    const encoded = encodeIpynb(
      decoded.notebook,
      JSON.stringify(decoded.source),
      decoded
    )
    const ids = JSON.parse(encoded.text).cells.map(
      (cell: { id: string }) => cell.id
    )

    expect(ids).toEqual(['invalid-id', 'invalid-id-2', 'code-cell'])
    expect(JSON.parse(encoded.text).cells[0].metadata).toMatchObject(
      sourceNotebook.cells[0].metadata
    )
  })

  it('round-trips Runme-specific metadata through the ipynb namespace', () => {
    const decoded = decodeIpynb(JSON.stringify(sourceNotebook))
    decoded.notebook.metadata['runme.dev/notebookSetting'] = 'keep'
    decoded.notebook.cells[2]!.languageId = 'bash'
    decoded.notebook.cells[2]!.metadata['runme.dev/runnerName'] = 'shell'

    const encoded = encodeIpynb(
      decoded.notebook,
      JSON.stringify(sourceNotebook),
      decoded
    )
    const portable = JSON.parse(encoded.text)
    expect(portable.metadata.runme).toMatchObject({
      version: 1,
      notebook: {
        metadata: {
          'runme.dev/notebookSetting': 'keep',
        },
      },
    })
    expect(portable.cells[2].metadata.runme).toMatchObject({
      version: 1,
      cell: {
        languageId: 'bash',
        metadata: {
          'runme.dev/runnerName': 'shell',
        },
      },
    })

    const reopened = decodeIpynb(encoded.text).notebook
    expect(reopened.metadata['runme.dev/notebookSetting']).toBe('keep')
    expect(reopened.cells[2]?.languageId).toBe('bash')
    expect(reopened.cells[2]?.metadata['runme.dev/runnerName']).toBe('shell')
  })

  it('rejects unsupported nbformat major versions', () => {
    expect(() =>
      decodeIpynb(
        JSON.stringify({
          ...sourceNotebook,
          nbformat: 3,
        })
      )
    ).toThrow('Unsupported Jupyter nbformat major version: 3')
  })

  it('rejects array-valued notebook and cell metadata', () => {
    expect(() =>
      decodeIpynb(
        JSON.stringify({
          ...sourceNotebook,
          metadata: [],
        })
      )
    ).toThrow('Jupyter notebook metadata must be a JSON object')

    const notebook = structuredClone(sourceNotebook)
    notebook.cells[0]!.metadata = [] as never
    expect(() => decodeIpynb(JSON.stringify(notebook))).toThrow(
      'Jupyter cell 0 metadata must be a JSON object'
    )
  })
})
