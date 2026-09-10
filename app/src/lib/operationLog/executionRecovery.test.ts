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

  it('keeps recovered source editable through save/reopen and never journals the diagnostic', async () => {
    const f = fixture()
    f.finish('left', [f.start.op_id])
    f.finish('right', [f.start.op_id])
    const previous = reopen(f.operations)
    expect(previous.cells[0]!.outputs[0]!.metadata[RECOVERED_OUTPUT_KEY]).toBe(
      'true'
    )
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
  })
})
