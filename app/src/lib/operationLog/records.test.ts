import { describe, expect, it } from 'vitest'

import {
  parseOperationLog,
  serializeOperationLog,
  validateOperation,
} from './codec'
import { previewComparison } from './comparisons'
import { materializeOperationLog } from './materialize'
import { createRunmeOperation } from './mutations'
import { committedOperationIds } from './order'
import {
  type CommentRecord,
  type RevisionRecord,
  projectRecord,
} from './records'
import type { RunmeOperation } from './types'
import { anchorSource, codePointRange, resolveVersion } from './versions'

const author = { displayName: 'Test', kind: 'agent' as const }
const header = {
  record_type: 'runme.notebook' as const,
  format_version: 2 as const,
  notebook_id: 'test',
  created_by: 'test',
  created_at: '2026-09-09T00:00:00Z',
}

function seed() {
  return createRunmeOperation({
    actorId: 'a',
    actorSequence: 1,
    dependencies: [],
    knownOperations: [],
    kind: 'cell.create',
    payload: {
      cell_id: 'cell',
      position: [[100, 'a', 1]],
      cell: {
        kind: 'markup',
        language_id: 'markdown',
        value: 'A😀B',
        metadata: {},
      },
    },
  })
}
function checkpoint(ops: RunmeOperation[], heads: string[]): RevisionRecord {
  const last = ops.at(-1)!
  return {
    record_type: 'runme.revision',
    format_version: 2,
    actor_id: 'r',
    actor_seq: 1,
    op_id: 'r:1',
    deps: [last.op_id],
    lamport: last.lamport + 1,
    created_at: header.created_at,
    snapshot_heads: heads,
    name: 'Reviewed',
    author,
  }
}
function comment(ops: RunmeOperation[]): CommentRecord {
  const last = ops.at(-1)!
  return {
    record_type: 'runme.comment',
    format_version: 2,
    actor_id: 'c',
    actor_seq: 1,
    op_id: 'c:1',
    thread_id: 'c:1',
    deps: [last.op_id],
    lamport: last.lamport + 1,
    created_at: header.created_at,
    author,
    body: { format: 'text/markdown', value: 'Explain this' },
    anchors: [
      {
        kind: 'cell',
        cell_id: 'cell',
        version: { kind: 'revision', revision_id: 'r:1' },
        surface: 'source',
        range: { start_index: 1, end_index: 2, unit: 'unicode-code-point' },
      },
    ],
  }
}

describe('first-class V2 records', () => {
  it('lets a reply cite a later version without changing its comparison endpoints', () => {
    const a = seed()
    const b = createRunmeOperation({
      actorId: 'a',
      actorSequence: 2,
      dependencies: [a.op_id],
      knownOperations: [a],
      kind: 'cell.update',
      payload: {
        cell_id: 'cell',
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'First response',
          metadata: {},
        },
      },
    })
    const start = { kind: 'operation' as const, op_id: a.op_id },
      end = { kind: 'operation' as const, op_id: b.op_id }
    const anchor = {
      kind: 'cell' as const,
      cell_id: 'cell',
      surface: 'source' as const,
      version: end,
    }
    const root = projectRecord({
      ...comment([a, b]),
      anchors: [anchor],
      comparison: { start, end },
    })
    const next = createRunmeOperation({
      actorId: 'a',
      actorSequence: 3,
      dependencies: [root.op_id],
      knownOperations: [a, b, root],
      kind: 'cell.update',
      payload: {
        cell_id: 'cell',
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Second response',
          metadata: {},
        },
      },
    })
    const reply = projectRecord({
      ...comment([a, b, root, next]),
      op_id: 'c:2',
      actor_seq: 2,
      parent_comment_id: root.op_id,
      anchors: [
        { ...anchor, version: { kind: 'operation', op_id: next.op_id } },
      ],
    })
    const parsed = parseOperationLog(
      serializeOperationLog(header, [a, b, root, next, reply])
    )
    expect(parsed.operations).toHaveLength(5)
    expect(
      anchorSource(
        parsed.operations,
        (reply.payload as CommentRecord).anchors![0]
      )
    ).toBe('Second response')
    expect((root.payload as CommentRecord).comparison).toEqual({ start, end })
  })
  it('serializes flat entities and derives quotes from historical source', () => {
    const a = seed()
    const r = projectRecord(checkpoint([a], [a.op_id]))
    const c = projectRecord(comment([a, r]))
    const text = serializeOperationLog(header, [a, r, c])
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[2]).toMatchObject({
      record_type: 'runme.revision',
      snapshot_heads: ['a:1'],
    })
    expect(lines[2]).not.toHaveProperty('payload')
    expect(lines[3]).toMatchObject({
      record_type: 'runme.comment',
      thread_id: 'c:1',
    })
    expect(lines[3]).not.toHaveProperty('kind')
    const parsed = parseOperationLog(text)
    expect(anchorSource(parsed.operations, comment([a, r]).anchors![0])).toBe(
      '😀'
    )
    expect(serializeOperationLog(header, parsed.operations)).toBe(text)
    const projected = materializeOperationLog(parsed.operations).comments[0]!
    const target = projected.payload.annotation.targets[0] as { anchor: string }
    expect(JSON.parse(target.anchor).runme.anchorSources).toEqual([
      { anchor: comment([a, r]).anchors![0], source: 'A😀B' },
    ])
    expect(text).not.toContain('anchorSources')
  })
  it('names an old snapshot without including the newer writer history', () => {
    const a = seed()
    const b = createRunmeOperation({
      actorId: 'a',
      actorSequence: 2,
      dependencies: ['a:1'],
      knownOperations: [a],
      kind: 'cell.update',
      payload: { cell_id: 'cell', cell: { value: 'new' } },
    })
    const r = projectRecord(checkpoint([a, b], ['a:1']))
    expect(
      resolveVersion([a, b, r], { kind: 'revision', revision_id: r.op_id }).map(
        (op) => op.op_id
      )
    ).toEqual(['a:1'])
    const late = { ...a, actor_id: '0', op_id: '0:1' }
    expect(
      resolveVersion([late, r, b, a], {
        kind: 'revision',
        revision_id: r.op_id,
      }).map((op) => op.op_id)
    ).toEqual(['a:1'])
  })
  it('rejects unseen snapshot references, redundant quotes and wrong units', () => {
    const a = seed(),
      r = projectRecord(checkpoint([a], ['missing']))
    expect(() => serializeOperationLog(header, [a, r])).toThrow('unseen')
    const valid = projectRecord(checkpoint([a], ['a:1']))
    const c = comment([a, valid])
    expect(() =>
      validateOperation({ ...c, anchors: [{ ...c.anchors![0], quote: '😀' }] })
    ).toThrow('derived')
    expect(() =>
      validateOperation({
        ...c,
        anchors: [
          {
            ...c.anchors![0],
            range: { start_index: 1, end_index: 2, unit: 'utf-16' },
          },
        ],
      })
    ).toThrow('range')
    expect(() =>
      serializeOperationLog({ ...header, format_version: 1 }, [a, valid])
    ).toThrow('migrate')
  })
  it('does not publish descendants of uncommitted transactions', () => {
    const a = { ...seed(), transaction_id: 'tx' }
    const b = createRunmeOperation({
      actorId: 'b',
      actorSequence: 1,
      dependencies: [a.op_id],
      knownOperations: [a],
      kind: 'notebook.update',
      payload: {},
    })
    expect([...committedOperationIds([a, b])]).toEqual([])
    expect(() =>
      resolveVersion([a, b], { kind: 'operation', op_id: b.op_id })
    ).toThrow('incomplete transaction')
  })
  it('converts UTF-16 explicitly and rejects broken surrogate selections', () => {
    expect(codePointRange('A😀B', 1, 3)).toEqual({
      start_index: 1,
      end_index: 2,
      unit: 'unicode-code-point',
    })
    expect(() => codePointRange('A😀B', 1, 2)).toThrow('surrogate')
  })
  it('captures both concurrent heads without admitting a later branch', () => {
    const a = seed()
    const b = createRunmeOperation({
      actorId: 'b',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'cell.create',
      payload: {
        cell_id: 'other',
        position: [[200, 'b', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Other',
          metadata: {},
        },
      },
    })
    const r = projectRecord({
      ...checkpoint([a, b], [a.op_id, b.op_id]),
      deps: [a.op_id, b.op_id],
    })
    const later = createRunmeOperation({
      actorId: 'z',
      actorSequence: 1,
      dependencies: [a.op_id],
      knownOperations: [a],
      kind: 'cell.update',
      payload: { cell_id: 'cell', cell: { value: 'Later' } },
    })
    const parsed = parseOperationLog(
      serializeOperationLog(header, [later, r, b, a])
    )
    expect(
      resolveVersion(parsed.operations, {
        kind: 'revision',
        revision_id: r.op_id,
      })
        .map((op) => op.op_id)
        .sort()
    ).toEqual(['a:1', 'b:1'])
  })
  it('uses the transaction commit as a public version, never a member', () => {
    const a = { ...seed(), transaction_id: 'tx' }
    const commit = createRunmeOperation({
      actorId: 'a',
      actorSequence: 2,
      dependencies: [a.op_id],
      knownOperations: [a],
      kind: 'transaction.commit',
      payload: { transaction_id: 'tx', members: [a.op_id] },
    })
    expect(
      resolveVersion([a, commit], { kind: 'operation', op_id: commit.op_id })
    ).toEqual([a, commit])
    expect(() =>
      resolveVersion([a, commit], { kind: 'operation', op_id: a.op_id })
    ).toThrow('incomplete transaction')
  })
  it('keeps old and new source anchors stable after moves and deletion', () => {
    const a = seed()
    const b = createRunmeOperation({
      actorId: 'a',
      actorSequence: 2,
      dependencies: [a.op_id],
      knownOperations: [a],
      kind: 'cell.update',
      payload: {
        cell_id: 'cell',
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Revised',
          metadata: {},
        },
      },
    })
    const start = { kind: 'operation' as const, op_id: a.op_id },
      end = { kind: 'operation' as const, op_id: b.op_id }
    const base = {
      kind: 'cell' as const,
      cell_id: 'cell',
      surface: 'source' as const,
      version: start,
    }
    const head = { ...base, version: end }
    const c = projectRecord({
      ...comment([a, b]),
      anchors: [base, head],
      comparison: { start, end },
    })
    const move = createRunmeOperation({
      actorId: 'a',
      actorSequence: 3,
      dependencies: [c.op_id],
      knownOperations: [a, b, c],
      kind: 'cell.move',
      payload: { cell_id: 'cell', position: [[500, 'a', 3]] },
    })
    const deleted = createRunmeOperation({
      actorId: 'a',
      actorSequence: 4,
      dependencies: [move.op_id],
      knownOperations: [a, b, c, move],
      kind: 'cell.delete',
      payload: { cell_id: 'cell' },
    })
    const parsed = parseOperationLog(
      serializeOperationLog(header, [a, b, c, move, deleted])
    )
    expect(anchorSource(parsed.operations, base)).toBe('A😀B')
    expect(anchorSource(parsed.operations, head)).toBe('Revised')
    expect(() =>
      anchorSource(parsed.operations, {
        ...head,
        version: { kind: 'operation', op_id: deleted.op_id },
      })
    ).toThrow('does not exist')
    expect(
      previewComparison(parsed.operations, {
        start: end,
        end: { kind: 'operation', op_id: deleted.op_id },
        cell_ids: ['cell'],
      }).diff.cells[0].kind
    ).toBe('deleted')
  })
  it('rejects grapheme-splitting ranges even at valid code-point boundaries', () => {
    const a = seed()
    ;(a.payload as any).cell.value = 'Ae\u0301B'
    const r = projectRecord(checkpoint([a], [a.op_id]))
    const c = projectRecord(comment([a, r]))
    expect(() => serializeOperationLog(header, [a, r, c])).toThrow('grapheme')
  })
  it('allows comparison endpoints with different non-content causal history', () => {
    const a = seed()
    const r = projectRecord(checkpoint([a], [a.op_id]))
    const note = projectRecord(comment([a, r]))
    const b = createRunmeOperation({
      actorId: 'a',
      actorSequence: 2,
      dependencies: [a.op_id],
      knownOperations: [a],
      kind: 'cell.update',
      payload: { cell_id: 'cell', cell: { value: 'Next' } },
    })
    const start = { kind: 'operation' as const, op_id: note.op_id },
      end = { kind: 'operation' as const, op_id: b.op_id }
    const comparison = projectRecord({
      ...comment([a, r, note, b]),
      op_id: 'd:1',
      actor_id: 'd',
      thread_id: 'd:1',
      lamport: note.lamport + 1,
      deps: [note.op_id, b.op_id],
      anchors: [
        { kind: 'notebook', version: start },
        { kind: 'notebook', version: end },
      ],
      comparison: { start, end },
    })
    expect(() =>
      serializeOperationLog(header, [a, r, note, b, comparison])
    ).not.toThrow()
  })
})
