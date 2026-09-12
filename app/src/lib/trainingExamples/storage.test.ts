import { describe, expect, it } from 'vitest'

import { serializeOperationLog } from '../operationLog/codec'
import { exampleHeader, exampleJournal } from './fixtures.test-helper'
import { type ExampleFiles, generateExampleIndex } from './storage'

const job = {
  localUri: 'local://file/test',
  sourcePath: 'runme/notebooks/test/document.runme',
  name: 'test.runme',
  driveFileId: 'drive-id',
}
function fixture() {
  const j = exampleJournal()
  j.cell('a', 'one', true)
  j.name('start')
  j.cell('a', 'two')
  j.name('end')
  const files = new Map<string, string>([
    [job.sourcePath, serializeOperationLog(exampleHeader, j.operations)],
  ])
  const adapter: ExampleFiles = {
    read: async (path) => files.get(path),
    write: async (path, value) => {
      files.set(path, value)
    },
    exclusive: async (_key, action) => action(),
  }
  return { files, adapter, j }
}

describe('OPFS example production', () => {
  it('writes a reference-only sibling and is idempotent on retry', async () => {
    const { files, adapter } = fixture()
    const result = await generateExampleIndex(adapter, job)
    expect(result.examples).toHaveLength(1)
    expect(result.header.source.driveFileId).toBe('drive-id')
    const bytes = files.get(job.sourcePath + '.examples')!
    expect(bytes.endsWith('\n')).toBe(true)
    expect(bytes.split('\n').filter(Boolean)).toHaveLength(2)
    expect(bytes).not.toContain('cell.update')
    expect(bytes).not.toContain('hidden-author')
    expect(await generateExampleIndex(adapter, job)).toEqual(result)
    expect(files.get(job.sourcePath + '.examples')).toBe(bytes)
  })
  it('preserves the previous sidecar when source history is corrupt', async () => {
    const { files, adapter } = fixture()
    await generateExampleIndex(adapter, job)
    const old = files.get(job.sourcePath + '.examples')
    files.set(job.sourcePath, 'not valid json\n')
    await expect(generateExampleIndex(adapter, job)).rejects.toThrow()
    expect(files.get(job.sourcePath + '.examples')).toBe(old)
  })
  it('preserves unrecognized sidecars and mismatched source identities', async () => {
    const { files, adapter } = fixture()
    const old =
      JSON.stringify({ record_type: 'other', format_version: 1 }) + '\n'
    files.set(job.sourcePath + '.examples', old)
    await expect(generateExampleIndex(adapter, job)).rejects.toThrow(
      'preserved'
    )
    expect(files.get(job.sourcePath + '.examples')).toBe(old)
  })
  it('retries if source changes before publication', async () => {
    const { files, adapter, j } = fixture()
    let changed = false
    adapter.exclusive = async (key, action) => {
      if (key.startsWith('runme:operation-log:') && !changed) {
        changed = true
        j.cell('a', 'three')
        j.name('third')
        files.set(
          job.sourcePath,
          serializeOperationLog(exampleHeader, j.operations)
        )
      }
      return action()
    }
    expect((await generateExampleIndex(adapter, job)).examples).toHaveLength(2)
  })
  it('fails without touching source when sidecar storage is full', async () => {
    const { files, adapter } = fixture()
    const before = files.get(job.sourcePath)
    adapter.write = async () => {
      throw new Error('Quota exceeded')
    }
    await expect(generateExampleIndex(adapter, job)).rejects.toThrow('Quota')
    expect(files.get(job.sourcePath)).toBe(before)
  })
})
