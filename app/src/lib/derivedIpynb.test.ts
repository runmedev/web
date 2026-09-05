// @vitest-environment node
import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import { parser_pb } from '../runme/client'
import { encodeDerivedIpynb } from './derivedIpynb'
import {
  AUTO_IPYNB_KEY,
  DERIVED_NOTEBOOK_KEY,
  parseDerivedSource,
} from './derivedNotebook'
import { decodeIpynb } from './ipynb'

describe('derived Colab copy', () => {
  it('preserves notebook cells and outputs, adds portable provenance and a notice', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      metadata: { [AUTO_IPYNB_KEY]: 'true' },
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'python-cell',
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: 'print(42)',
          outputs: [
            create(parser_pb.CellOutputSchema, {
              items: [
                create(parser_pb.CellOutputItemSchema, {
                  mime: 'text/plain',
                  data: new TextEncoder().encode('42'),
                }),
              ],
            }),
          ],
        }),
      ],
    })
    const source = {
      version: 1 as const,
      uri: 'https://drive.google.com/file/d/source/view',
      notebookId: 'source-id',
      generatedAt: '2026-09-05T00:00:00Z',
    }
    const text = encodeDerivedIpynb(notebook, source)
    const exported = JSON.parse(text)
    expect(exported.metadata.runme.derivedFrom).toEqual(source)
    expect(exported.cells[0].source).toContain('will be overwritten')
    expect(exported.cells[1].source).toBe('print(42)')
    expect(exported.cells[1].outputs).toHaveLength(1)
    const decoded = decodeIpynb(text).notebook
    expect(parseDerivedSource(decoded.metadata[DERIVED_NOTEBOOK_KEY])).toEqual(
      source
    )
    expect(decoded.metadata[AUTO_IPYNB_KEY]).toBeUndefined()
    expect(notebook.metadata[AUTO_IPYNB_KEY]).toBe('true')
    expect(notebook.cells).toHaveLength(1)
  })
  it('rejects unsafe source links', () => {
    expect(
      parseDerivedSource({
        version: 1,
        uri: 'javascript:alert(1)',
        notebookId: 'a',
        generatedAt: '',
      })
    ).toBeNull()
  })
})
