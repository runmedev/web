import { describe, expect, it, vi } from 'vitest'

import type LocalNotebooks from '../../storage/local'
import { getExampleSelection } from './registry'
import { createTrainingExamplesApi } from './runtime'

const client = vi.hoisted(() => ({
  load: vi.fn(),
  preview: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('./client', () => ({
  loadTrainingExamples: client.load,
  loadTrainingExamplePreview: client.preview,
  cancelTrainingExamples: client.cancel,
}))
vi.mock('../notebookDataController', () => ({
  getNotebookDataController: () => ({ getNotebookData: () => undefined }),
}))
vi.mock('../workspaceDocuments/workspaceDocumentController', () => ({
  showWorkspaceDocument: vi.fn(),
}))

describe('notebook-centric training API', () => {
  const job = {
    localUri: 'local://file/source',
    sourcePath: 'runme/notebooks/source/document.runme',
    name: 'design.runme',
    driveFileId: 'drive-source',
  }
  const source = { driveFileId: 'drive-source' }
  const example = {
    id: 'example',
    base: [],
    diff: [],
    accepted: true,
    provenance: {
      source,
      labelSource: 'named-revision' as const,
      recordIds: ['a:3'],
      cellIds: ['a'],
      start: null,
      end: { kind: 'operation' as const, op_id: 'a:2' },
    },
  }
  function setup() {
    vi.clearAllMocks()
    const store = {
      files: {
        toArray: async () => [
          {
            id: job.localUri,
            remoteId: 'https://drive.google.com/file/d/drive-source/view',
            operationLogRef: { path: job.sourcePath },
          },
        ],
      },
      trainingExampleJob: vi.fn(async () => job),
    } as unknown as LocalNotebooks
    const open = vi.fn(async (uri) => uri)
    return {
      api: createTrainingExamplesApi({
        localStore: () => store,
        driveStore: () => null,
        openNotebook: open,
      }),
      open,
    }
  }
  it('extracts explicit sources, prepares off-thread and opens only the selected recipe list', async () => {
    const { api, open } = setup()
    client.load.mockResolvedValue({
      examples: [example],
      issues: [],
      sourceChecksum: 'abc',
    })
    const result = await api.extract({
      source,
      sources: ['named-revision'],
      syntheticReverse: false,
    })
    expect(result.examples[0].provenance.source).toEqual(source)
    expect(open).not.toHaveBeenCalled()
    expect(client.load).toHaveBeenCalledWith(
      job,
      { sources: ['named-revision'], syntheticReverse: false },
      undefined
    )
    client.preview.mockResolvedValue({
      input: { initial: [], operations: [] },
      diff: { cells: [] },
    })
    expect(await api.prepare(example)).toEqual({ initial: [], operations: [] })
    await api.preview([example])
    expect(getExampleSelection(job.localUri)?.examples).toEqual([example])
    expect(open).toHaveBeenCalledWith(job.localUri)
    await expect(api.show([example, example])).rejects.toThrow('Duplicate')
  })
  it('runs the short CUJ with Runme URLs and returns an array', async () => {
    const { api } = setup()
    client.load.mockResolvedValue({ examples: [example], issues: [] })
    const url =
      'https://web.runme.dev/?doc=' +
      encodeURIComponent('https://drive.google.com/file/d/drive-source/view')
    const examples = []
    for (const notebookUrl of [url])
      examples.push(...(await api.extract(notebookUrl)))
    await api.preview(examples)
    expect(examples).toEqual([example])
    expect(client.load.mock.calls[0][0]).toEqual(job)
    client.load.mockResolvedValue({
      examples: [],
      issues: [{ reason: 'ambiguous baseline' }],
    })
    await expect(api.extract(url)).rejects.toThrow('ambiguous baseline')
  })
  it('prepares self-contained examples without reading source storage', async () => {
    setup()
    client.preview.mockResolvedValue({ input: { initial: [], operations: [] } })
    const api = createTrainingExamplesApi({
      localStore: () => null,
      driveStore: () => null,
      openNotebook: vi.fn(),
    })
    await expect(api.prepare(example)).resolves.toEqual({
      initial: [],
      operations: [],
    })
    expect(client.preview).toHaveBeenCalledWith(example, undefined)
  })
  it('fails on invalid source selectors and missing source locators', async () => {
    const { api } = setup()
    await expect(
      api.extract({ source, sources: ['unknown' as any] })
    ).rejects.toThrow('Unknown')
    await expect(
      api.prepare({
        ...example,
        provenance: { ...example.provenance, source: undefined as any },
      })
    ).rejects.toThrow('source')
    await expect(
      api.extract({ source: { driveFileId: '../invalid' } })
    ).rejects.toThrow('Expected')
    expect(client.load).not.toHaveBeenCalled()
  })
})
