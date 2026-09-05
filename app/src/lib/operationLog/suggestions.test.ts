import { describe, expect, it } from 'vitest'

import {
  type JsonValue,
  type RunmeOperation,
  buildOperationLogSuggestions,
  createRunmeOperation,
  createSuggestionCommentAnchor,
  diffInlineText,
  materializeOperationLog,
  parseSuggestionCommentAnchor,
} from '.'

function append(
  operations: RunmeOperation[],
  input: {
    sequence: number
    kind: string
    payload: JsonValue
    suggestionId?: string
    transactionId?: string
    reverts?: string[]
  }
): RunmeOperation {
  return createRunmeOperation({
    actorId: 'actor_a',
    actorSequence: input.sequence,
    dependencies: operations.length
      ? [operations[operations.length - 1].op_id]
      : [],
    knownOperations: operations,
    kind: input.kind,
    payload: input.payload,
    suggestionId: input.suggestionId,
    transactionId: input.transactionId,
    reverts: input.reverts,
    createdAt: `2026-09-03T00:00:0${input.sequence}Z`,
  })
}

describe('operation-log suggestions', () => {
  it('groups operations and reconstructs their before/proposed cell diff', () => {
    const operations: RunmeOperation[] = []
    operations.push(
      append(operations, {
        sequence: 1,
        kind: 'cell.create',
        suggestionId: 'suggestion:create',
        payload: {
          cell_id: 'one',
          position: [[100, 'actor_a', 1]],
          cell: {
            kind: 'markup',
            language_id: 'markdown',
            value: 'Hello world',
            metadata: {},
          },
        },
      })
    )
    operations.push(
      append(operations, {
        sequence: 2,
        kind: 'cell.update',
        suggestionId: 'suggestion:update',
        payload: {
          cell_id: 'one',
          cell: {
            kind: 'markup',
            language_id: 'markdown',
            value: 'Hello brave world',
            metadata: {},
          },
        },
      })
    )

    const suggestions = buildOperationLogSuggestions(operations)
    expect(suggestions.map((suggestion) => suggestion.id)).toEqual([
      'suggestion:create',
      'suggestion:update',
    ])
    expect(suggestions[0].changedCells[0].kind).toBe('inserted')
    expect(suggestions[1].changedCells[0].kind).toBe('modified')
    expect(suggestions[1].before.cells[0].value).toBe('Hello world')
    expect(suggestions[1].proposed.cells[0].value).toBe('Hello brave world')
  })

  it('uses the latest review to reject and later restore suggestion operations', () => {
    const operations: RunmeOperation[] = []
    operations.push(
      append(operations, {
        sequence: 1,
        kind: 'cell.create',
        suggestionId: 'suggestion:create',
        payload: {
          cell_id: 'one',
          position: [[100, 'actor_a', 1]],
          cell: {
            kind: 'markup',
            language_id: 'markdown',
            value: 'Original',
            metadata: {},
          },
        },
      })
    )
    operations.push(
      append(operations, {
        sequence: 2,
        kind: 'cell.update',
        suggestionId: 'suggestion:update',
        payload: {
          cell_id: 'one',
          cell: {
            kind: 'markup',
            language_id: 'markdown',
            value: 'Proposed',
            metadata: {},
          },
        },
      })
    )
    operations.push(
      append(operations, {
        sequence: 3,
        kind: 'suggestion.review',
        reverts: ['actor_a:2'],
        payload: {
          suggestion_id: 'suggestion:update',
          decision: 'reject',
          operation_ids: ['actor_a:2'],
        },
      })
    )
    expect(materializeOperationLog(operations).notebook.cells[0].value).toBe(
      'Original'
    )

    operations.push(
      append(operations, {
        sequence: 4,
        kind: 'suggestion.review',
        payload: {
          suggestion_id: 'suggestion:update',
          decision: 'accept',
          operation_ids: ['actor_a:2'],
        },
      })
    )
    const materialized = materializeOperationLog(operations)
    expect(materialized.notebook.cells[0].value).toBe('Proposed')
    expect(materialized.suggestionReviews['suggestion:update'].decision).toBe(
      'accept'
    )
  })

  it('includes the commit envelope when previewing a legacy transaction', () => {
    const operations: RunmeOperation[] = []
    const first = append(operations, {
      sequence: 1,
      kind: 'cell.create',
      transactionId: 'transaction:create',
      payload: {
        cell_id: 'one',
        position: [[100, 'actor_a', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Created atomically',
          metadata: {},
        },
      },
    })
    operations.push(first)
    const commit = append(operations, {
      sequence: 2,
      kind: 'transaction.commit',
      payload: {
        transaction_id: 'transaction:create',
        members: [first.op_id],
      },
    })
    operations.push(commit)

    const suggestions = buildOperationLogSuggestions(operations)

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].id).toBe('transaction:create')
    expect(suggestions[0].changedCells[0].kind).toBe('inserted')
    expect(suggestions[0].proposed.cells[0].value).toBe('Created atomically')
  })

  it('omits execution-metadata-only cell updates', () => {
    const operations: RunmeOperation[] = []
    operations.push(
      append(operations, {
        sequence: 1,
        kind: 'cell.create',
        suggestionId: 'suggestion:create',
        payload: {
          cell_id: 'one',
          position: [[100, 'actor_a', 1]],
          cell: {
            kind: 'code',
            language_id: 'bash',
            value: 'echo hello',
            metadata: {},
          },
        },
      })
    )
    operations.push(
      append(operations, {
        sequence: 2,
        kind: 'cell.update',
        suggestionId: 'suggestion:execution',
        payload: {
          cell_id: 'one',
          cell: {
            kind: 'code',
            language_id: 'bash',
            value: 'echo hello',
            metadata: {
              'runme.dev/lastRunID': 'run-1',
              'runme.dev/executionState': 'running',
            },
          },
        },
      })
    )

    expect(
      buildOperationLogSuggestions(operations).map(
        (suggestion) => suggestion.id
      )
    ).toEqual(['suggestion:create'])
  })

  it('produces an inline word diff with preserved whitespace', () => {
    expect(diffInlineText('hello world', 'hello brave world')).toEqual([
      { kind: 'equal', value: 'hello ' },
      { kind: 'inserted', value: 'brave ' },
      { kind: 'equal', value: 'world' },
    ])
  })

  it('round trips suggestion comment anchors and ignores other anchors', () => {
    const anchor = createSuggestionCommentAnchor('suggestion:1')
    expect(parseSuggestionCommentAnchor(anchor)).toBe('suggestion:1')
    expect(parseSuggestionCommentAnchor('{"cell":"one"}')).toBeNull()
    expect(parseSuggestionCommentAnchor('not json')).toBeNull()
  })
})
