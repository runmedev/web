// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { beforeEach, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import type LocalNotebooks from '../storage/local'
import { computeNotebookDiff } from './notebookDiff/diff'
import { saveGraderSettings } from './suggestionGrader'
import { createSuggestionGraderApi } from './suggestionGraderRuntime'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})
it('grades the requested immutable comparison using the same client as the UI, without decisions', async () => {
  const before = create(parser_pb.NotebookSchema, { cells: [] })
  const after = create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        refId: 'a',
        kind: parser_pb.CellKind.MARKUP,
        languageId: 'markdown',
        value: 'Hello',
      }),
    ],
  })
  const previewNotebookComparison = vi.fn(async () => ({
    before,
    after,
    diff: computeNotebookDiff(before, after),
  }))
  const store = { previewNotebookComparison } as unknown as LocalNotebooks
  saveGraderSettings({
    enabled: true,
    model: 'ft:test',
    organization: '',
    project: '',
    apiKey: 'secret-key',
  })
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'false' }],
            },
          ],
        })
      )
    )
  const api = createSuggestionGraderApi({ localStore: () => store })
  const comparison = { startRevisionId: 'empty', endRevisionId: 'r1' }
  const result = await api.grade({
    target: { uri: 'local://file/test' },
    comparison,
    cellId: 'a',
  })
  expect(result.accepted).toBe(false)
  expect(previewNotebookComparison).toHaveBeenCalledWith(
    'local://file/test',
    comparison
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(api.getSettings())).not.toContain('secret-key')
  await expect(
    api.grade({ target: { uri: 'remote' }, comparison, cellId: 'a' })
  ).rejects.toThrow('target.uri')
})
