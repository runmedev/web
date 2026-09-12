import { describe, expect, it } from 'vitest'

import { createRunmeOperation } from '../operationLog/mutations'
import { exampleJournal } from './fixtures.test-helper'
import {
  type ExampleCell,
  applyExampleEdits,
  compressSnapshots,
  exampleSnapshot,
  extractExamples,
  prepareExample,
} from './model'
import { previewExample } from './preview'

const cells = (...ids: string[]): ExampleCell[] =>
  ids.map((cell) => ({ cell, kind: 'code', language: 'bash', value: cell }))

describe('content compression', () => {
  it('replays updates, inserts, deletes, moves and multiple cells in both directions', () => {
    const before = cells('a', 'b', 'c')
    const after = cells('c', 'new', 'a')
    after[0].value = 'new 😀 text\n'
    after[0].language = 'python'
    const forward = compressSnapshots(before, after)
    expect(new Set(forward.map((edit) => edit.kind))).toEqual(
      new Set(['delete', 'move', 'insert', 'update'])
    )
    expect(applyExampleEdits(before, forward)).toEqual(after)
    expect(applyExampleEdits(after, compressSnapshots(after, before))).toEqual(
      before
    )
    expect(before).toEqual(cells('a', 'b', 'c'))
    expect(compressSnapshots(before, before)).toEqual([])
  })
  it('validates anchors, duplicate IDs and missing update/delete targets', () => {
    expect(() => compressSnapshots(cells('a', 'a'), cells('b'))).toThrow(
      'Duplicate'
    )
    expect(() => compressSnapshots(cells('a'), cells('b', 'b'))).toThrow(
      'Duplicate'
    )
    expect(() =>
      applyExampleEdits([], [{ kind: 'delete', cell: 'a' }])
    ).toThrow('target')
    expect(() =>
      applyExampleEdits(cells('a'), [
        { kind: 'move', cell: 'a', after: 'missing' },
      ])
    ).toThrow('anchor')
    expect(() =>
      applyExampleEdits(cells('a'), [{ kind: 'move', cell: 'a', after: 'a' }])
    ).toThrow('itself')
  })
  it('round trips deterministic combinations of cell presence/order', () => {
    const variants = [
      [],
      ['a'],
      ['b', 'a'],
      ['c', 'a', 'b'],
      ['b', 'c'],
      ['a', 'new', 'c'],
    ]
    for (const a of variants)
      for (const b of variants) {
        const before = cells(...a),
          after = cells(...b).map((cell) => ({
            ...cell,
            value: cell.value + ' changed',
          }))
        expect(
          applyExampleEdits(before, compressSnapshots(before, after))
        ).toEqual(after)
      }
  })
})

describe('revision-pair examples', () => {
  it('squashes intermediate updates, strips leakage and leaves source history untouched', () => {
    const j = exampleJournal()
    j.cell('opaque-cell-id', 'original', true)
    const start = j.name('private name')
    j.cell('opaque-cell-id', 'temporary')
    j.cell('opaque-cell-id', 'final 😀\n')
    const end = j.name('private reviewer approved')
    j.decide(start, end, 'opaque-cell-id', 'accept')
    const original = JSON.stringify(j.operations)
    const input = prepareExample(j.operations, { start, end })
    expect(input.operations).toEqual([
      {
        kind: 'update',
        cell: 'cell-1',
        content: { kind: 'code', language: 'bash', value: 'final 😀\n' },
      },
    ])
    for (const secret of [
      'opaque-cell-id',
      'hidden-author',
      'hidden-comment',
      'private',
      'temporary',
      'accepted',
      'created_at',
    ])
      expect(JSON.stringify(input)).not.toContain(secret)
    expect(JSON.stringify(j.operations)).toBe(original)
  })
  it('does not absorb later concurrent edits into a version', () => {
    const j = exampleJournal()
    const start = j.cell('a', 'original', true)
    const end = j.cell('a', 'target')
    const input = prepareExample(j.operations, { start, end })
    const seed = j.operations[0]
    j.operations.push(
      createRunmeOperation({
        actorId: 'concurrent',
        actorSequence: 1,
        dependencies: [seed.op_id],
        knownOperations: [seed],
        kind: 'cell.update',
        payload: {
          cell_id: 'a',
          cell: {
            kind: 'code',
            language_id: 'bash',
            value: 'concurrent edit',
            metadata: {},
          },
        },
      })
    )
    expect(prepareExample(j.operations, { start, end })).toEqual(input)
    expect(() =>
      exampleSnapshot(j.operations, { kind: 'operation', op_id: 'missing:1' })
    ).toThrow('unavailable')
  })
  it('stores adjacent named pairs and optional reverse negatives; previews use those endpoints', () => {
    const j = exampleJournal()
    j.cell('a', 'gcloud logging read BAD', true)
    const start = j.name('before')
    j.cell('a', 'gcloud logging read GOOD')
    const middle = j.name('after')
    j.cell('b', 'new cell', true, 200)
    const end = j.name('third')
    const extracted = extractExamples(j.operations, 'notebook')
    expect(extracted.examples).toHaveLength(2)
    expect(extracted.examples.map(({ start, end }) => [start, end])).toEqual(
      expect.arrayContaining([
        [start, middle],
        [middle, end],
      ])
    )
    expect(extracted.examples.every((e) => e.accepted)).toBe(true)
    const synthetic = extractExamples(j.operations, 'notebook', {
      syntheticReverse: true,
    }).examples
    expect(
      synthetic.filter((e) => e.provenance.source === 'synthetic-reverse')
    ).toHaveLength(2)
    const reverse = synthetic.find(
      (e) =>
        e.provenance.source === 'synthetic-reverse' &&
        JSON.stringify(e.start) === JSON.stringify(middle)
    )!
    expect(reverse.accepted).toBe(false)
    const preview = previewExample(j.operations, reverse)
    expect(preview.diff.cells[0].baseCell?.value).toContain('GOOD')
    expect(preview.diff.cells[0].compareCell?.value).toContain('BAD')
    expect(preview.diff.cells).toHaveLength(1)
  })
  it('deduplicates aliases and ignores metadata-only/no-op transitions', () => {
    const j = exampleJournal()
    j.cell('a', 'same', true)
    j.name('first')
    j.name('alias')
    j.cell('a', 'temporary')
    j.cell('a', 'same')
    j.name('last')
    expect(extractExamples(j.operations, 'notebook').examples).toEqual([])
  })
  it('repartitions pairs after historical naming without retaining obsolete examples', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    const start = j.name('start')
    const middleOp = j.cell('a', 'two')
    j.cell('a', 'three')
    const end = j.name('end')
    expect(extractExamples(j.operations, 'notebook').examples).toHaveLength(1)
    const middle = j.name('historical', [(middleOp as { op_id: string }).op_id])
    const examples = extractExamples(j.operations, 'notebook').examples
    expect(examples.map((e) => [e.start, e.end])).toEqual(
      expect.arrayContaining([
        [start, middle],
        [middle, end],
      ])
    )
    expect(examples).toHaveLength(2)
    expect(
      extractExamples([...j.operations].reverse(), 'notebook').examples
    ).toEqual(examples)
  })
  it('uses review undo as rejection of the forward pair, and reports conflicting evidence', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    const start = j.name('start')
    j.cell('a', 'two')
    const end = j.name('end')
    j.decide(start, end, 'a', 'undo')
    j.cell('a', 'one')
    const result = extractExamples(j.operations, 'notebook')
    const negative = result.examples.find((e) => !e.accepted)!
    expect(negative.start).toEqual(start)
    expect(negative.end).toEqual(end)
    expect(
      result.issues.some((issue) => issue.reason.includes('Conflicting'))
    ).toBe(true)
  })
  it('defers a partial cell assessment over a multi-cell delta', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    const start = j.name('start')
    j.cell('a', 'two')
    j.cell('b', 'new', true, 200)
    const end = j.name('end')
    j.decide(start, end, 'a', 'accept')
    const result = extractExamples(j.operations, 'notebook')
    expect(result.examples).toHaveLength(1)
    expect(result.issues[0].reason).toContain('only part')
  })
  it('fails closed on unknown history rather than training on recovered content', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    const start = j.name('start')
    j.append('future.content', { value: 'unsupported' })
    const end = j.name('end')
    expect(() => prepareExample(j.operations, { start, end })).toThrow(
      'unsupported'
    )
  })
  it('defers a merged named revision with incomparable nearest named predecessors', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    j.name('start')
    const common = [...j.operations]
    j.cell('a', 'branch A')
    j.name('A')
    const branch = createRunmeOperation({
      actorId: 'branch',
      actorSequence: 1,
      dependencies: [common[common.length - 1].op_id],
      knownOperations: common,
      kind: 'cell.update',
      payload: {
        cell_id: 'a',
        cell: {
          kind: 'code',
          language_id: 'bash',
          value: 'branch B',
          metadata: {},
        },
      },
    })
    j.operations.push(branch)
    j.name('B', [branch.op_id])
    j.name('merged')
    const result = extractExamples(j.operations, 'notebook')
    expect(result.examples).toHaveLength(2)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].reason).toContain('incomparable')
  })
  it('never extracts a partial transaction as a version', () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    const start = j.name('start')
    const end = j.cell('a', 'uncommitted')
    j.operations[j.operations.length - 1].transaction_id = 'incomplete'
    expect(() => prepareExample(j.operations, { start, end })).toThrow(
      'incomplete transaction'
    )
  })
})
