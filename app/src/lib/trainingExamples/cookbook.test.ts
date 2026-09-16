import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import cookbook from '../../../../docs/training-examples-cookbook.json'
import { encodeJsonl, encodeSftExample } from './encoding'
import { exampleJournal } from './fixtures.test-helper'
import { EXAMPLE_RULE_VERSION, extractExamples } from './model'
import { prepareRecordExample } from './recordInput'

// Execute the checked-in recipe itself so API/await drift cannot leave docs broken.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const code = cookbook.cells.find(
  (c) => c.refId === 'training_extract_encode'
)!.value

describe('executable dataset cookbook', () => {
  it('runs extraction, native preparation, JSONL and preview without upload', async () => {
    const j = exampleJournal()
    j.cell('cell-a', 'before', true)
    j.name('baseline')
    j.cell('cell-a', 'after')
    j.name('draft')
    const extracted = extractExamples(j.operations, 'source')
    const log = vi.fn()
    const api = {
      extract: vi.fn(async () => ({
        ...extracted,
        sourceChecksum: 'test',
        ruleVersion: EXAMPLE_RULE_VERSION,
      })),
      prepare: vi.fn(async (example) => prepareRecordExample(example)),
      encodeSftExample,
      encodeJsonl,
      preview: vi.fn(async () => {}),
      uploadOpenAIJsonl: vi.fn(),
    }
    await new AsyncFunction('trainingExamples', 'console', 'crypto', code)(
      api,
      { log },
      webcrypto
    )
    expect(api.extract).toHaveBeenCalledWith({
      source: { driveFileId: '1ZxXleLr8obZjsgf8ytAbJ9YM0cI3YSJl' },
      sources: ['named-revision'],
      syntheticReverse: false,
    })
    expect(api.preview).toHaveBeenCalledWith(extracted.examples)
    expect(api.uploadOpenAIJsonl).not.toHaveBeenCalled()
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rows: 2,
        labels: ['true', 'true'],
        uploaded: false,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    )
  })

  it('rejects an empty source instead of claiming a working dataset', async () => {
    const api = { extract: async () => ({ examples: [], issues: [] }) }
    await expect(
      new AsyncFunction('trainingExamples', 'console', 'crypto', code)(
        api,
        { log: vi.fn() },
        webcrypto
      )
    ).rejects.toThrow('content change')
  })
  it('executes the design CUJ as JavaScript with the array-returning API', async () => {
    const cuj = cookbook.cells.find(
      (c) => c.refId === 'training_extract_preview'
    )!.value
    const api = {
      extract: vi.fn(async () => [{ id: 'example' }]),
      preview: vi.fn(),
    }
    await new AsyncFunction('trainingExamples', 'console', cuj)(api, {
      log: vi.fn(),
    })
    expect(api.extract).toHaveBeenCalledWith(
      expect.stringContaining('1ZxXleLr8obZjsgf8ytAbJ9YM0cI3YSJl')
    )
    expect(api.preview).toHaveBeenCalledWith([{ id: 'example' }])
  })
})
