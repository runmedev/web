// @vitest-environment node
import { create, toJson } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import {
  MimeType,
  RunmeExecutionState,
  RunmeMetadataKey,
  parser_pb,
} from '../../runme/client'
import { encodeDerivedIpynb } from '../derivedIpynb'
import { encodeIpynb } from '../ipynb'
import { serializeNotebookToMarkdown } from '../markdown/serializeNotebookToMarkdown'
import { encodeRunmeNotebook } from '../notebookFormat'
import { buildOperationLogDiff, cloneNotebook } from './editorJournal'
import { materializeOperationLog } from './materialize'
import { causalHeads, createRunmeOperation } from './mutations'
import { RECOVERED_OUTPUT_KEY, materializedLogToNotebook } from './notebook'
import type { ExecutionFinishPayload, JsonValue, RunmeOperation } from './types'

/** Build real causal records, including concurrent completions for the same run. */
function fixture() {
  const operations: RunmeOperation[] = []
  const append = (
    kind: string,
    payload: JsonValue,
    deps = causalHeads(operations)
  ) => {
    const op = createRunmeOperation({
      actorId: `actor_${operations.length}`,
      actorSequence: 1,
      knownOperations: operations,
      dependencies: deps,
      kind,
      payload,
    })
    operations.push(op)
    return op
  }
  const cell = append('cell.create', {
    cell_id: 'cell-1',
    position: [[1, 'seed', 1]],
    cell: {
      kind: 'code',
      language_id: 'javascript',
      value: 'console.log("hello")',
      metadata: {
        [RunmeMetadataKey.LastRunID]: 'run-1',
        [RunmeMetadataKey.ExecutionState]: RunmeExecutionState.Completed,
      },
    },
  })
  const start = append('execution.start', {
    execution_id: 'run-1',
    cell_id: 'cell-1',
    source_op_id: cell.op_id,
    input: {
      language_id: 'javascript',
      value: 'console.log("hello")',
      execution_metadata: {},
    },
    input_sha256: 'source-hash',
    runner: {
      runner_id: 'browser',
      runtime: 'javascript',
      runtime_version: '1',
      environment_digest: null,
    },
    started_at: '2026-09-09T00:00:00Z',
  })
  const finish = (text: string, deps?: string[], executionId = 'run-1') =>
    append(
      'execution.finish',
      {
        execution_id: executionId,
        status: 'succeeded',
        outputs: [
          toJson(
            parser_pb.CellOutputSchema,
            create(parser_pb.CellOutputSchema, {
              items: [
                create(parser_pb.CellOutputItemSchema, {
                  mime: MimeType.VSCodeNotebookStdOut,
                  type: 'Buffer',
                  data: new TextEncoder().encode(text),
                }),
              ],
            })
          ) as JsonValue,
        ],
        execution_summary: {},
        finished_at: '2026-09-09T00:00:01Z',
      },
      deps
    )
  return { operations, append, start, finish }
}

function reopen(operations: RunmeOperation[]) {
  return materializedLogToNotebook(materializeOperationLog(operations))
}

function outputText(notebook: parser_pb.Notebook) {
  return notebook.cells[0]!.outputs.flatMap((o) =>
    o.items.map((i) => new TextDecoder().decode(i.data))
  ).join('')
}

describe('execution output recovery', () => {
  it.each([false, true])(
    'accepts equivalent duplicate starts (concurrent=%s) without losing completed output',
    (concurrent) => {
      const f = fixture()
      f.finish('saved result')
      f.append(
        'execution.start',
        {
          ...(f.start.payload as object),
          started_at: '2030-01-01T00:00:00Z',
        } as JsonValue,
        concurrent ? f.start.deps : undefined
      )
      const original = JSON.stringify(f.operations)
      expect(outputText(reopen(f.operations))).toBe('saved result')
      expect(outputText(reopen([...f.operations].reverse()))).toBe(
        'saved result'
      )
      expect(materializeOperationLog(f.operations).executions).toHaveLength(1)
      expect(JSON.stringify(f.operations)).toBe(original)
    }
  )

  it('does not reactivate an old run when its duplicate arrives after a rerun or clear', () => {
    const f = fixture()
    f.finish('old')
    f.append('execution.start', {
      ...(f.start.payload as object),
      execution_id: 'new',
    } as JsonValue)
    f.finish('new', undefined, 'new')
    f.append('execution.start', f.start.payload)
    f.finish('late old')
    expect(outputText(reopen(f.operations))).toBe('new')
    f.append('cell.clear_outputs', {
      cell_id: 'cell-1',
      reason: 'user-cleared',
    })
    f.append('execution.start', f.start.payload)
    expect(reopen(f.operations).cells[0]!.outputs).toEqual([])
  })

  it('supersedes a run when the rerun observes only a concurrent alias', () => {
    const f = fixture()
    const alias = f.append('execution.start', f.start.payload, f.start.deps)
    const next = f.append(
      'execution.start',
      { ...(f.start.payload as object), execution_id: 'new' } as JsonValue,
      [alias.op_id]
    )
    f.finish('new', [next.op_id], 'new')
    f.finish('late old', [f.start.op_id])
    expect(outputText(reopen(f.operations))).toBe('new')
    expect(outputText(reopen([...f.operations].reverse()))).toBe('new')
  })

  it('keeps an unobserved conflicting start until a rerun observes both branches', () => {
    const f = fixture()
    const other = f.append(
      'execution.start',
      { ...(f.start.payload as object), input_sha256: 'conflict' } as JsonValue,
      f.start.deps
    )
    const next = f.append(
      'execution.start',
      {
        ...(f.start.payload as object),
        execution_id: 'partial-rerun',
      } as JsonValue,
      [f.start.op_id]
    )
    f.finish('partial', [next.op_id], 'partial-rerun')
    expect(outputText(reopen(f.operations))).toContain(
      'conflicting start records'
    )
    f.append('execution.start', {
      ...(f.start.payload as object),
      execution_id: 'resolved',
    } as JsonValue)
    f.finish('resolved', undefined, 'resolved')
    // This conflicting re-recording happens after the new run. It is historical,
    // and must not make the already superseded execution active again.
    f.append('execution.start', other.payload)
    expect(outputText(reopen(f.operations))).toBe('resolved')
  })

  it('ignores rejected and uncommitted duplicate starts', () => {
    const f = fixture()
    f.finish('valid')
    const rejected = f.append('execution.start', {
      ...(f.start.payload as object),
      input_sha256: 'rejected',
    } as JsonValue)
    f.append('suggestion.review', {
      suggestion_id: `legacy:${rejected.op_id}`,
      operation_ids: [rejected.op_id],
      decision: 'reject',
    })
    const pending = f.append('execution.start', {
      ...(f.start.payload as object),
      input_sha256: 'pending',
    } as JsonValue)
    pending.transaction_id = 'not-committed'
    expect(outputText(reopen(f.operations))).toBe('valid')
  })

  it('isolates conflicting cell associations to both affected cells', () => {
    const f = fixture()
    const cell = f.operations[0]!
    f.append('cell.create', {
      ...(cell.payload as object),
      cell_id: 'cell-2',
      position: [[2, 'seed', 1]],
    } as JsonValue)
    f.append('execution.start', {
      ...(f.start.payload as object),
      cell_id: 'cell-2',
    } as JsonValue)
    f.finish('ambiguous')
    const recovered = reopen(f.operations)
    expect(recovered.cells).toHaveLength(2)
    for (const cell of recovered.cells)
      expect(outputText({ ...recovered, cells: [cell] })).toContain(
        'conflicting start records'
      )
    f.append('execution.start', {
      ...(f.start.payload as object),
      execution_id: 'new',
    } as JsonValue)
    f.finish('fresh', undefined, 'new')
    expect(outputText(reopen(f.operations))).toBe('fresh')
    expect(
      outputText({ ...recovered, cells: [reopen(f.operations).cells[1]!] })
    ).toContain('conflicting start records')
  })

  it('does not emit a second start when stale metadata returns to an existing run', async () => {
    const f = fixture()
    f.finish('saved')
    const next = reopen(f.operations)
    const previous = cloneNotebook(next)
    delete previous.cells[0]!.metadata[RunmeMetadataKey.LastRunID]
    previous.cells[0]!.outputs = []
    const changes = await buildOperationLogDiff({
      previous,
      next,
      observedOperations: f.operations,
      actorId: 'stale',
      firstActorSequence: 1,
    })
    expect(changes.some((op) => op.kind === 'execution.start')).toBe(false)
    expect(changes.some((op) => op.kind === 'execution.finish')).toBe(true)
    expect(outputText(reopen([...f.operations, ...changes]))).toBe('saved')
  })

  it('still records a distinct run after a previous execution', async () => {
    const f = fixture()
    f.finish('saved')
    const previous = reopen(f.operations)
    const next = cloneNotebook(previous)
    next.cells[0]!.metadata[RunmeMetadataKey.LastRunID] = 'new'
    next.cells[0]!.metadata[RunmeMetadataKey.ExecutionState] =
      RunmeExecutionState.Running
    next.cells[0]!.outputs = []
    const changes = await buildOperationLogDiff({
      previous,
      next,
      observedOperations: f.operations,
      actorId: 'new',
      firstActorSequence: 1,
    })
    expect(changes.filter((op) => op.kind === 'execution.start')).toHaveLength(
      1
    )
    expect(reopen([...f.operations, ...changes]).cells[0]!.outputs).toEqual([])
  })

  it('preserves the only completed result when another tab concurrently starts a run', () => {
    const f = fixture()
    f.append(
      'execution.start',
      {
        ...(f.start.payload as object),
        execution_id: 'concurrent-run',
      } as JsonValue,
      f.start.deps
    )
    f.finish('available output', [f.start.op_id])
    expect(outputText(reopen(f.operations))).toBe('available output')
    expect(outputText(reopen([...f.operations].reverse()))).toBe(
      'available output'
    )
  })

  it('shows conflicting concurrent runs until a causally later rerun replaces both', () => {
    const f = fixture()
    const concurrent = f.append(
      'execution.start',
      {
        ...(f.start.payload as object),
        execution_id: 'concurrent-run',
      } as JsonValue,
      f.start.deps
    )
    f.finish('left', [f.start.op_id])
    f.finish('right', [concurrent.op_id], 'concurrent-run')
    expect(outputText(reopen(f.operations))).toContain('Concurrent executions')
    expect(outputText(reopen([...f.operations].reverse()))).toBe(
      outputText(reopen(f.operations))
    )
    f.append('execution.start', {
      ...(f.start.payload as object),
      execution_id: 'rerun',
    } as JsonValue)
    expect(reopen(f.operations).cells[0]!.outputs).toEqual([])
    f.finish('fresh output', undefined, 'rerun')
    expect(outputText(reopen(f.operations))).toBe('fresh output')
  })

  it('retains valid output siblings when one output fails protobuf decoding', () => {
    const f = fixture()
    const finish = f.finish('valid stdout')
    const payload = finish.payload as unknown as ExecutionFinishPayload
    payload.outputs = [
      payload.outputs[0]!,
      null,
      { items: [{ mime: 'text/plain', data: 'dmFsaWQgcmlnaHQ=' }] },
    ]
    const notebook = reopen(f.operations)
    expect(notebook.cells[0]!.outputs).toHaveLength(3)
    expect(
      new TextDecoder().decode(notebook.cells[0]!.outputs[0]!.items[0]!.data)
    ).toBe('valid stdout')
    expect(
      new TextDecoder().decode(notebook.cells[0]!.outputs[1]!.items[0]!.data)
    ).toContain('corrupt saved output (item 2)')
    expect(
      new TextDecoder().decode(notebook.cells[0]!.outputs[2]!.items[0]!.data)
    ).toBe('valid right')
  })

  it('uses a causally later completion to retain late output, regardless of timestamp', () => {
    const f = fixture()
    f.finish('first chunk')
    f.append('cell.move', { cell_id: 'cell-1', position: [[2, 'seed', 1]] })
    const later = f.finish('first chunk\nlast chunk')
    ;(later.payload as unknown as ExecutionFinishPayload).finished_at =
      '2020-01-01T00:00:00Z'
    expect(outputText(reopen(f.operations))).toBe('first chunk\nlast chunk')
  })

  it('accepts identical concurrent results despite different completion timestamps', () => {
    const f = fixture()
    f.finish('same', [f.start.op_id])
    const duplicate = f.finish('same', [f.start.op_id])
    ;(duplicate.payload as unknown as ExecutionFinishPayload).finished_at =
      '2030-01-01T00:00:00Z'
    expect(outputText(reopen(f.operations))).toBe('same')
  })

  it('shows a deterministic cell-level error for conflicting results without changing history', () => {
    const f = fixture()
    f.finish('left', [f.start.op_id])
    f.finish('right', [f.start.op_id])
    const original = JSON.stringify(f.operations)
    const notebook = reopen(f.operations)
    expect(notebook.cells[0]!.value).toBe('console.log("hello")')
    expect(outputText(notebook)).toContain(
      'conflicting or invalid completion records'
    )
    expect(outputText(notebook)).toContain('Run this cell again')
    expect(outputText(reopen([...f.operations].reverse()))).toBe(
      outputText(notebook)
    )
    expect(
      materializeOperationLog(f.operations).executions[0]!.finish
    ).toBeUndefined()
    expect(JSON.stringify(f.operations)).toBe(original)
  })

  it('does not let a successor on only one branch hide the other conflicting result', () => {
    const f = fixture()
    const left = f.finish('left', [f.start.op_id])
    f.finish('right', [f.start.op_id])
    f.finish('left updated', [left.op_id])
    expect(outputText(reopen(f.operations))).toContain('conflicting')
    f.finish('reconciled')
    expect(outputText(reopen(f.operations))).toBe('reconciled')
  })

  it('treats concurrent status or summary disagreement as ambiguous even with the same output', () => {
    const f = fixture()
    f.finish('same', [f.start.op_id])
    const other = f.finish('same', [f.start.op_id])
    ;(other.payload as unknown as ExecutionFinishPayload).status = 'failed'
    expect(outputText(reopen(f.operations))).toContain('conflicting')
    ;(other.payload as unknown as ExecutionFinishPayload).status = 'succeeded'
    ;(other.payload as unknown as ExecutionFinishPayload).execution_summary = {
      success: false,
    }
    expect(outputText(reopen(f.operations))).toContain('conflicting')
  })

  it('clears recovered output at the next start and ignores late finishes from the old run', () => {
    const f = fixture()
    f.finish('left', [f.start.op_id])
    f.finish('right', [f.start.op_id])
    const oldHeads = causalHeads(f.operations)
    f.append('execution.start', {
      ...(f.start.payload as object),
      execution_id: 'run-2',
    } as JsonValue)
    expect(reopen(f.operations).cells[0]!.outputs).toEqual([])
    f.finish('fresh output', undefined, 'run-2')
    f.finish('late old output', oldHeads)
    expect(outputText(reopen(f.operations))).toBe('fresh output')
    f.append('cell.clear_outputs', {
      cell_id: 'cell-1',
      reason: 'user-cleared',
    })
    expect(reopen(f.operations).cells[0]!.outputs).toEqual([])
  })

  it.each([null, {}, { items: [{ data: 'not-valid-base64!!!' }] }])(
    'isolates malformed protobuf output %j to its cell',
    (badOutput) => {
      const f = fixture()
      const finish = f.finish('valid')
      ;(finish.payload as unknown as ExecutionFinishPayload).outputs = [
        badOutput as JsonValue,
      ]
      // An empty object is a valid empty protobuf output; corrupt values get a diagnostic.
      const notebook = reopen(f.operations)
      expect(notebook.cells[0]!.value).toContain('console.log')
      if (badOutput === null || 'items' in badOutput)
        expect(outputText(notebook)).toContain('corrupt saved output')
    }
  )

  it('opens a malformed outputs collection with a diagnostic instead of throwing', () => {
    const f = fixture()
    const finish = f.finish('valid')
    ;(finish.payload as unknown as ExecutionFinishPayload).outputs =
      null as unknown as JsonValue[]
    expect(outputText(reopen(f.operations))).toContain('completion records')
  })

  it('persists a failed setup attempt that replaces recovered output without a backend run ID', async () => {
    const f = fixture()
    f.finish('left', [f.start.op_id])
    f.finish('right', [f.start.op_id])
    const previous = reopen(f.operations)
    const next = cloneNotebook(previous)
    delete next.cells[0]!.metadata[RunmeMetadataKey.LastRunID]
    next.cells[0]!.metadata[RunmeMetadataKey.ExecutionState] =
      RunmeExecutionState.Completed
    next.cells[0]!.metadata[RunmeMetadataKey.ExitCode] = '1'
    next.cells[0]!.outputs = [
      create(parser_pb.CellOutputSchema, {
        items: [
          create(parser_pb.CellOutputItemSchema, {
            mime: MimeType.VSCodeNotebookStdErr,
            type: 'Buffer',
            data: new TextEncoder().encode('Runner backend unavailable'),
          }),
        ],
      }),
    ]
    const changes = await buildOperationLogDiff({
      previous,
      next,
      observedOperations: f.operations,
      actorId: 'failed-rerun',
      firstActorSequence: 1,
    })
    f.operations.push(...changes)
    expect(outputText(reopen(f.operations))).toBe('Runner backend unavailable')
    expect(
      (
        changes.find((op) => op.kind === 'execution.finish')!
          .payload as unknown as ExecutionFinishPayload
      ).status
    ).toBe('failed')
    const unchanged = await buildOperationLogDiff({
      previous: next,
      next,
      observedOperations: f.operations,
      actorId: 'failed-rerun',
      firstActorSequence: changes.length + 1,
    })
    expect(unchanged).toEqual([])
  })

  it('keeps user-cleared recovery-only outputs cleared after reopening', async () => {
    const f = fixture()
    f.finish('left', [f.start.op_id])
    f.finish('right', [f.start.op_id])
    const previous = reopen(f.operations)
    const next = cloneNotebook(previous)
    next.cells[0]!.outputs = []
    delete next.cells[0]!.metadata[RunmeMetadataKey.LastRunID]
    delete next.cells[0]!.metadata[RunmeMetadataKey.ExecutionState]
    const changes = await buildOperationLogDiff({
      previous,
      next,
      observedOperations: f.operations,
      actorId: 'clear',
      firstActorSequence: 1,
    })
    expect(changes.some((op) => op.kind === 'cell.clear_outputs')).toBe(true)
    f.operations.push(...changes)
    expect(reopen(f.operations).cells[0]!.outputs).toEqual([])
    expect(
      f.operations.filter((op) => op.kind === 'execution.finish')
    ).toHaveLength(2)
  })

  it('omits recovery diagnostics from IPYNB, JSON, and Markdown exports without changing the model', () => {
    const f = fixture()
    const finish = f.finish('valid sibling')
    ;(finish.payload as unknown as ExecutionFinishPayload).outputs.push(null)
    const notebook = reopen(f.operations)
    expect(outputText(notebook)).toContain('corrupt saved output')
    const exports = [
      encodeIpynb(notebook).text,
      encodeRunmeNotebook(notebook),
      serializeNotebookToMarkdown(notebook),
      encodeDerivedIpynb(notebook, {
        version: 1,
        uri: 'https://drive.google.com/file/d/source/view',
        notebookId: 'test',
        generatedAt: '2026-09-10T00:00:00Z',
        operationIds: f.operations.map((op) => op.op_id),
      }),
    ]
    for (const exported of exports) {
      expect(exported).not.toContain('corrupt saved output')
      expect(exported).not.toContain(RECOVERED_OUTPUT_KEY)
    }
    const ipynb = JSON.parse(exports[0]!)
    expect(ipynb.cells[0].outputs).toHaveLength(1)
    expect(JSON.stringify(ipynb.cells[0].outputs)).toContain('valid sibling')
    expect(outputText(notebook)).toContain('corrupt saved output')
    expect(notebook.cells[0]!.outputs).toHaveLength(2)
  })

  it.each(['finish', 'start'])(
    'keeps recovered %s conflicts editable through save/reopen/rerun without journaling diagnostics',
    async (conflict) => {
      const f = fixture()
      f.finish('left', [f.start.op_id])
      if (conflict === 'finish') f.finish('right', [f.start.op_id])
      else
        f.append('execution.start', {
          ...(f.start.payload as object),
          input_sha256: 'conflicting-hash',
        } as JsonValue)
      const previous = reopen(f.operations)
      expect(
        previous.cells[0]!.outputs[0]!.metadata[RECOVERED_OUTPUT_KEY]
      ).toBe('true')
      const edited = cloneNotebook(previous)
      edited.cells[0]!.value = 'console.log("edited")'
      const changes = await buildOperationLogDiff({
        previous,
        next: edited,
        observedOperations: f.operations,
        actorId: 'editor',
        firstActorSequence: 1,
      })
      expect(changes.map((op) => op.kind)).toEqual(['cell.update'])
      expect(JSON.stringify(changes)).not.toContain('conflicting or invalid')
      f.operations.push(...changes)
      const saved = reopen(f.operations)
      expect(saved.cells[0]!.value).toBe('console.log("edited")')
      expect(outputText(saved)).toContain('conflicting')

      const running = cloneNotebook(saved)
      running.cells[0]!.metadata[RunmeMetadataKey.LastRunID] = 'rerun'
      running.cells[0]!.metadata[RunmeMetadataKey.ExecutionState] =
        RunmeExecutionState.Running
      running.cells[0]!.outputs = []
      const rerun = await buildOperationLogDiff({
        previous: saved,
        next: running,
        observedOperations: f.operations,
        actorId: 'runner',
        firstActorSequence: 1,
      })
      f.operations.push(...rerun)
      expect(reopen(f.operations).cells[0]!.outputs).toEqual([])
      f.finish('recovered', undefined, 'rerun')
      expect(outputText(reopen(f.operations))).toBe('recovered')
    }
  )
})
