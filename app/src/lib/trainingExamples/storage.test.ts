import { describe, expect, it, vi } from 'vitest'

import { serializeOperationLog } from '../operationLog/codec'
import { exampleHeader, exampleJournal } from './fixtures.test-helper'
import { generateExampleIndex } from './storage'

const job = {
  localUri: 'local://file/test',
  sourcePath: 'runme/notebooks/test/document.runme',
  name: 'test.runme',
  driveFileId: 'drive-id',
}

describe('explicit read-only example extraction', () => {
  it('returns portable references from one frozen read and never writes a sidecar', async () => {
    const j = exampleJournal()
    j.cell('a', 'one', true)
    j.name('start')
    j.cell('a', 'two')
    j.name('end')
    const bytes = serializeOperationLog(exampleHeader, j.operations)
    const read = vi.fn(async () => bytes)
    const write = vi.fn()
    const index = await generateExampleIndex({ read, ...{ write } }, job)
    expect(index.examples).toHaveLength(2)
    expect(index.examples[0].provenance.source).toEqual({
      driveFileId: 'drive-id',
    })
    expect(index.sourceChecksum).toMatch(/^[a-f0-9]{32}$/)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(job.sourcePath)
    expect(write).not.toHaveBeenCalled()
    expect(await generateExampleIndex({ read }, job)).toEqual(index)
    expect(
      (
        await generateExampleIndex({ read }, job, {
          sources: ['cell-decision'],
        })
      ).examples
    ).toEqual([])
    expect(
      (await generateExampleIndex({ read }, job, { syntheticReverse: true }))
        .examples
    ).toHaveLength(4)
  })
  it('fails closed on missing or corrupt history without reading old sidecars', async () => {
    const read = vi.fn(async () => 'invalid\n')
    await expect(generateExampleIndex({ read }, job)).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
    await expect(
      generateExampleIndex({ read: async () => undefined }, job)
    ).rejects.toThrow('unavailable')
  })
  it.each([
    'missing-dependency',
    'incomplete-transaction',
    'unknown-operation',
  ])(
    'does not export a valid prefix when later history has %s',
    async (problem) => {
      const j = exampleJournal()
      j.cell('a', 'one', true)
      j.name('baseline')
      j.cell('a', 'later')
      const last = j.operations.at(-1)!
      if (problem === 'missing-dependency') last.deps.push('missing:1')
      if (problem === 'incomplete-transaction')
        last.transaction_id = 'unfinished'
      if (problem === 'unknown-operation') last.kind = 'future.content'
      const bytes = serializeOperationLog(exampleHeader, j.operations)
      await expect(
        generateExampleIndex({ read: async () => bytes }, job)
      ).rejects.toThrow(/incomplete|unsupported/)
    }
  )
})
