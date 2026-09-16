import { describe, expect, it } from 'vitest'

import { parseOperationLog, serializeOperationLog } from '../operationLog/codec'
import { materializeOperationLog } from '../operationLog/materialize'
import type { RunmeOperation } from '../operationLog/types'
import { exampleHeader, exampleJournal } from './fixtures.test-helper'
import { extractExamples } from './model'
import { previewExample } from './preview'

describe('labeled cell versions', () => {
  it('uses an empty implicit baseline and emits one example per changed cell', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    j.cell('b', 'two', true, 200)
    j.name('first')
    const result = extractExamples(j.operations, 'drive-id')
    expect(result.issues).toEqual([])
    expect(result.examples).toHaveLength(2)
    for (const e of result.examples) {
      expect(e.base).toEqual([])
      expect(e.diff).toHaveLength(1)
      expect(e.provenance.start).toBeNull()
      expect(e.accepted).toBe(true)
      const parsed = parseOperationLog(
        serializeOperationLog(exampleHeader, [
          ...e.base,
          ...e.diff,
        ] as RunmeOperation[])
      )
      expect(
        materializeOperationLog(parsed.operations).notebook.cells
      ).toHaveLength(1)
    }
  })
  it('rejects a commented intermediate version, not the latest cell, and deduplicates replies', () => {
    const j = exampleJournal()
    j.cell('a', 'baseline', true)
    const baseline = j.name('baseline')
    const bad = j.cell('a', 'bad')
    const root = j.comment('a', bad)
    j.cell('a', 'fixed')
    j.name('fixed')
    j.comment('a', bad, root)
    const result = extractExamples(j.operations, 'drive-id')
    const negative = result.examples.filter((e) => !e.accepted)
    expect(negative).toHaveLength(1)
    expect(negative[0].provenance.start).toEqual(baseline)
    expect(negative[0].provenance.recordIds).toHaveLength(2)
    const row = previewExample([], negative[0]).diff.cells[0]
    expect(row.baseCell?.value).toBe('baseline')
    expect(row.compareCell?.value).toBe('bad')
    const input = JSON.stringify([...negative[0].base, ...negative[0].diff])
    expect(input).not.toContain('hidden-author')
    expect(input).not.toContain('hidden-comment')
    expect(input).not.toContain('fixed')
  })
  it('a cell version present in any named snapshot is positive despite comments', () => {
    const j = exampleJournal()
    const cell = j.cell('a', 'one', true)
    j.comment('a', cell)
    j.cell('b', 'other', true, 200)
    j.name('approved')
    const result = extractExamples(j.operations, 'drive-id')
    expect(result.examples).toHaveLength(2)
    expect(result.examples.every((e) => e.accepted)).toBe(true)
    expect(
      extractExamples(j.operations, 'drive-id', { sources: ['comment'] })
        .examples
    ).toEqual([])
  })
  it('explicit decisions override weak inference; conflicting explicit decisions defer', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    const start = j.name('first')
    const end = j.cell('a', 'two')
    j.name('second')
    j.decide(start, end, 'a', 'undo')
    let result = extractExamples(j.operations, 'drive-id')
    expect(result.examples.filter((e) => !e.accepted)).toHaveLength(1)
    j.decide(start, end, 'a', 'accept')
    result = extractExamples(j.operations, 'drive-id')
    expect(result.issues[0].reason).toContain('Conflicting explicit')
    expect(result.examples).toHaveLength(1)
  })
  it('isolates deletes and leaves other baseline cells unchanged', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    j.cell('b', 'context', true, 200)
    j.name('first')
    j.append('cell.delete', { cell_id: 'a' })
    j.cell('b', 'new context')
    j.name('second')
    const e = extractExamples(j.operations, 'drive-id').examples.find((e) =>
      e.diff.some((r) => (r as RunmeOperation).kind === 'cell.delete')
    )!
    expect(e.diff).toHaveLength(1)
    const result = materializeOperationLog([
      ...e.base,
      ...e.diff,
    ] as RunmeOperation[])
    expect(result.notebook.cells.map((c) => c.value)).toEqual(['context'])
  })
  it('moves only the labeled cell, never its neighbors', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    j.cell('b', 'two', true, 200)
    j.cell('c', 'three', true, 300)
    j.name('first')
    j.append('cell.move', { cell_id: 'a', position: [[400, 'source', 1]] })
    j.name('moved')
    const e = extractExamples(j.operations, 'drive-id').examples.find((e) =>
      e.diff.some((r) => (r as RunmeOperation).kind === 'cell.move')
    )!
    expect(e.diff).toHaveLength(1)
    expect((e.diff[0] as RunmeOperation).payload).toMatchObject({
      cell_id: 'cell-1',
    })
    expect(
      materializeOperationLog([
        ...e.base,
        ...e.diff,
      ] as RunmeOperation[]).notebook.cells.map((c) => c.value)
    ).toEqual(['two', 'three', 'one'])
  })
  it('reuses a cell version across unrelated revisions and is independent of file ordering', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    j.name('first')
    j.cell('b', 'two', true, 200)
    j.name('second')
    j.name('alias')
    const result = extractExamples(j.operations, 'drive-id')
    expect(result.examples).toHaveLength(2)
    expect(
      result.examples.filter((e) => e.provenance.cellIds.includes('a'))
    ).toHaveLength(1)
    expect(extractExamples([...j.operations].reverse(), 'drive-id')).toEqual(
      result
    )
  })
})
