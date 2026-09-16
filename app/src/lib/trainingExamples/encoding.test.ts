import { describe, expect, it, vi } from 'vitest'

import { encodeJsonl, encodeSftExample, uploadOpenAIJsonl } from './encoding'
import { exampleJournal } from './fixtures.test-helper'
import { prepareContentExample, replayContent } from './payloads'

describe('native payload classifier encoding', () => {
  it('replays native create/update/delete/move payloads without attribution or intermediate edits', () => {
    const j = exampleJournal()
    j.cell('opaque-a', 'before', true)
    j.cell('b', 'delete', true, 200)
    j.cell('c', 'move', true, 300)
    const start = j.name('private baseline')
    j.cell('opaque-a', 'intermediate')
    j.cell('opaque-a', 'after 😀\n')
    j.append('cell.delete', { cell_id: 'b' })
    j.append('cell.move', { cell_id: 'c', position: [[0, 'test', 1]] })
    j.cell('new', 'insert', true, 50)
    const end = j.name('private approved')
    const before = JSON.stringify(j.operations)
    const prepared = prepareContentExample(j.operations, { start, end })
    expect(new Set(prepared.operations.map((op) => op.kind))).toEqual(
      new Set(['cell.update', 'cell.create', 'cell.move', 'cell.delete'])
    )
    expect(
      replayContent(prepared.initial, prepared.operations).map(
        (c) => c.cell.value
      )
    ).toEqual(['move', 'insert', 'after 😀\n'])
    for (const word of ['opaque-a', 'hidden-author', 'private', 'intermediate'])
      expect(JSON.stringify(prepared)).not.toContain(word)
    expect(JSON.stringify(j.operations)).toBe(before)
    for (const accepted of [true, false]) {
      const row = encodeSftExample(prepared, accepted)
      expect(row.reference_answer).toBe(String(accepted))
      expect(row.messages).toHaveLength(1)
      expect(row.messages[0].role).toBe('user')
      expect(row.messages[0].content).not.toContain('reference_answer')
      const jsonl = encodeJsonl([row])
      expect(jsonl.split('\n')).toHaveLength(2)
      expect(JSON.parse(jsonl)).toEqual(row)
    }
  })
  it('validates before upload, uses multipart, and makes exactly one request', async () => {
    const row = encodeSftExample({ initial: [], operations: [] }, false)
    const requestFiles = vi.fn(
      async () =>
        ({ ok: true, json: async () => ({ id: 'file-test' }) }) as Response
    )
    const jsonl = encodeJsonl([row])
    expect(
      await uploadOpenAIJsonl({ jsonl, filename: 'train.jsonl', requestFiles })
    ).toEqual({ id: 'file-test', bytes: new Blob([jsonl]).size })
    expect(requestFiles).toHaveBeenCalledOnce()
    const call = requestFiles.mock.calls[0] as unknown as [
      { method: string; body: FormData },
    ]
    expect(call[0].method).toBe('POST')
    expect(call[0].body.get('purpose')).toBe('fine-tune')
    expect(call[0]).not.toHaveProperty('headers')
    requestFiles.mockClear()
    await expect(
      uploadOpenAIJsonl({
        jsonl: '{}\n',
        filename: 'train.jsonl',
        requestFiles,
      })
    ).rejects.toThrow('Invalid')
    expect(requestFiles).not.toHaveBeenCalled()
    requestFiles.mockRejectedValue(new Error('network timeout'))
    await expect(
      uploadOpenAIJsonl({ jsonl, filename: 'train.jsonl', requestFiles })
    ).rejects.toThrow('timeout')
    expect(requestFiles).toHaveBeenCalledOnce()
    expect(() => encodeJsonl([])).toThrow('empty')
  })
})
