import { describe, expect, it } from 'vitest'

import type { RunmeOperation } from '../operationLog/types'
import { type ExampleCell, compressSnapshots } from './model'
import { planContentExample, replayContent } from './payloads'
import { contentRecords, prepareRecordExample } from './recordInput'

describe('self-contained native record examples', () => {
  const before: ExampleCell[] = [
    { cell: 'cell-1', kind: 'code', language: 'bash', value: 'echo before' },
    {
      cell: 'cell-2',
      kind: 'markup',
      language: 'markdown',
      value: 'old context',
    },
  ]
  const after: ExampleCell[] = [
    {
      cell: 'cell-1',
      kind: 'code',
      language: 'python',
      value: 'print("after 😀")',
    },
    {
      cell: 'cell-3',
      kind: 'markup',
      language: 'markdown',
      value: 'new context',
    },
  ]
  const records = () =>
    contentRecords(
      planContentExample({
        initial: before,
        operations: compressSnapshots(before, after),
      })
    )

  it('supports multiple changed cells without rereading source history', () => {
    const input = prepareRecordExample(records())
    const final = replayContent(input.initial, input.operations)
    expect(
      final.map((c) => ({
        cell: c.cell_id,
        kind: c.cell.kind,
        language: c.cell.language_id,
        value: c.cell.value,
      }))
    ).toEqual(after)
    expect(input.operations.map((op) => op.kind)).toEqual([
      'cell.delete',
      'cell.update',
      'cell.create',
    ])
  })
  it('rejects duplicate identities and missing dependency closure', () => {
    const duplicate = records()
    duplicate.diff.push(duplicate.diff[0])
    expect(() => prepareRecordExample(duplicate)).toThrow('self-contained')
    const missing = records()
    ;(missing.diff[0] as RunmeOperation).deps = ['missing:1']
    expect(() => prepareRecordExample(missing)).toThrow('self-contained')
  })
  it('rejects unsupported and transactional records before replay', () => {
    const unsupported = records()
    ;(unsupported.diff[0] as RunmeOperation).kind = 'future.operation'
    expect(() => prepareRecordExample(unsupported)).toThrow()
    const transactional = records()
    ;(transactional.diff[0] as RunmeOperation).transaction_id = 'transaction'
    expect(() => prepareRecordExample(transactional)).toThrow()
  })
  it('rejects a recoverable but incomplete base and malformed cell payload', () => {
    const missing = records()
    ;(missing.base[0] as RunmeOperation).kind = 'cell.update'
    expect(() => prepareRecordExample(missing)).toThrow('Missing')
    const malformed = records()
    ;((malformed.base[0] as RunmeOperation).payload as any).cell.value = 123
    expect(() => prepareRecordExample(malformed)).toThrow(
      'Invalid cell content'
    )
  })
  it('strips metadata from native diff payloads and normalizes recipe identities', () => {
    const example = records()
    for (const record of [
      ...example.base,
      ...example.diff,
    ] as RunmeOperation[]) {
      const payload = record.payload as any
      payload.cell_id = payload.cell_id.replace('cell-', 'opaque-')
      if (payload.position) payload.position[0][1] = 'secret-position-author'
      if (payload.cell) {
        payload.cell.metadata = { accepted: false, author: 'hidden-author' }
        payload.cell.outputs = ['hidden-output']
      }
    }
    const original = JSON.stringify(example)
    const input = prepareRecordExample(example)
    for (const hidden of [
      'opaque-',
      'hidden-author',
      'secret-position-author',
      'hidden-output',
      'accepted',
    ])
      expect(JSON.stringify(input)).not.toContain(hidden)
    expect(JSON.stringify(example)).toBe(original)
    expect(
      replayContent(input.initial, input.operations).map((c) => c.cell.value)
    ).toEqual(after.map((c) => c.value))
  })
})
