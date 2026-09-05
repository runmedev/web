import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import { DERIVED_NOTEBOOK_KEY } from './derivedNotebook'
import { NotebookData } from './notebookData'

describe('derived notebook model', () => {
  it('cannot be edited or saved even after requesting writable state', async () => {
    const save = vi.fn(async () => {})
    const model = new NotebookData({
      uri: 'local://file/copy',
      name: 'copy.ipynb',
      loaded: true,
      notebookStore: { save },
      notebook: create(parser_pb.NotebookSchema, {
        metadata: {
          [DERIVED_NOTEBOOK_KEY]: JSON.stringify({
            version: 1,
            uri: 'https://drive.google.com/file/d/source/view',
            notebookId: 'source',
            generatedAt: '2026-09-05T00:00:00Z',
          }),
        },
      }),
    })
    model.setReadOnly(false)
    expect(model.isReadOnly()).toBe(true)
    expect(model.getSnapshot().readOnly).toBe(true)
    expect(() => model.setMetadataProperty('description', 'edit')).toThrow(
      'read-only'
    )
    await model.flushPendingPersist()
    expect(save).not.toHaveBeenCalled()
  })
})
