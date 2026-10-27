// @vitest-environment node
import { create } from '@bufbuild/protobuf'
import { expect, it, vi } from 'vitest'

import { createInitialNotebookFile } from '../lib/notebookFormat'
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
