// @vitest-environment node
import { create } from '@bufbuild/protobuf'
import { expect, it, vi } from 'vitest'

import { createInitialNotebookFile } from '../lib/notebookFormat'
import {
  type RunmeOperation,
  materializeOperationLog,
  materializedLogToNotebook,
  mergeOperationSets,
  parseOperationLog,
  serializeOperationLog,
} from '../lib/operationLog'
import { parser_pb } from '../runme/client'
import { EditorSaveSession } from './editorSaveSession'

it('captures the submitted snapshot while typing continues and retries identical operations after failure', async () => {
  let acknowledge!: () => void
  const commit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve
        })
    )
    .mockRejectedValueOnce(new Error('Worker exited'))
    .mockResolvedValue(undefined)
  const session = new EditorSaveSession(
    'local://file/test',
    createInitialNotebookFile('test.runme'),
    commit
  )
  const editor = session.initialNotebook
  editor.cells.push(
    create(parser_pb.CellSchema, {
      refId: 'one',
      kind: parser_pb.CellKind.MARKUP,
      value: 'submitted',
    })
  )
  const first = session.save('local://file/test', editor)
  await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce())
  editor.cells[0].value = 'typed while waiting'
  acknowledge()
  await first
  await expect(session.save('local://file/test', editor)).rejects.toThrow(
    'Worker exited'
  )
  expect(session.hasPending).toBe(true)
  const failed = structuredClone(commit.mock.calls[1])
  expect(
    failed[2].some(
      (op: any) =>
        op.kind === 'cell.update' &&
        op.payload.cell.value === 'typed while waiting'
    )
  ).toBe(true)
  await session.resume()
  expect(commit.mock.calls[2]).toEqual(failed)
  expect(session.hasPending).toBe(false)
})

it('restores a lost-ack batch and later typing without overwriting another tab’s edits', async () => {
  const uri = 'local://file/recovery'
  const initial = createInitialNotebookFile('recovery.runme')
  let durable = initial
  const commit = vi.fn(
    async (_uri: string, _id: string, operations: RunmeOperation[]) => {
      const parsed = parseOperationLog(durable)
      durable = serializeOperationLog(
        parsed.header,
        mergeOperationSets(parsed.operations, operations)
      )
    }
  )
  const first = new EditorSaveSession(uri, initial, async (...args) => {
    await commit(...args)
    throw new Error('Lost reply after durable commit')
  })
  const editor = first.initialNotebook
  editor.cells.push(
    create(parser_pb.CellSchema, {
      refId: 'mine',
      kind: parser_pb.CellKind.MARKUP,
      value: 'submitted',
    })
  )
  await expect(first.save(uri, editor)).rejects.toThrow('Lost reply')
  const originalBatch = structuredClone(commit.mock.calls[0][2])
  const other = new EditorSaveSession(uri, initial, commit)
  other.initialNotebook.cells.push(
    create(parser_pb.CellSchema, {
      refId: 'theirs',
      kind: parser_pb.CellKind.MARKUP,
      value: 'other tab',
    })
  )
  await other.save(uri, other.initialNotebook)
  editor.cells[0].value = 'typed after submission'
  const checkpoint = JSON.parse(JSON.stringify(await first.checkpoint(editor)))
  const restored = new EditorSaveSession(
    uri,
    checkpoint.document,
    commit,
    checkpoint.actorId,
    checkpoint
  )
  expect(restored.initialNotebook.cells[0].value).toBe('typed after submission')
  await restored.save(uri, restored.initialNotebook)
  expect(commit.mock.calls[2][2]).toEqual(originalBatch)
  const parsed = parseOperationLog(durable)
  expect(new Set(parsed.operations.map((op) => op.op_id)).size).toBe(
    parsed.operations.length
  )
  expect(
    materializedLogToNotebook(materializeOperationLog(parsed.operations))
      .cells.map((cell) => cell.value)
      .sort()
  ).toEqual(['other tab', 'typed after submission'])
})

it('resumes the original editor after checkpoint persistence fails', async () => {
  const commit = vi.fn(async () => {})
  const session = new EditorSaveSession(
    'uri',
    createInitialNotebookFile('test.runme'),
    commit
  )
  await session.checkpoint()
  await expect(session.save('uri', session.initialNotebook)).rejects.toThrow(
    'paused'
  )
  session.resumeAfterFailedCheckpoint()
  session.initialNotebook.cells.push(
    create(parser_pb.CellSchema, { refId: 'new', value: 'retained' })
  )
  await session.save('uri', session.initialNotebook)
  expect(commit).toHaveBeenCalledOnce()
})
