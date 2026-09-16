import { driveFileUrl, parseDriveItem } from '../../storage/drive'
import type { DriveNotebookStore } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import { getNotebookDataController } from '../notebookDataController'
import {
  getTrainingJob,
  submitTrainingJob,
  uploadOpenAIJsonl,
} from '../openaiTraining'
import { showWorkspaceDocument } from '../workspaceDocuments/workspaceDocumentController'
import { getOperationLogSuggestionDocumentUri } from '../workspaceDocuments/workspaceDocumentTypes'
import {
  cancelTrainingExamples,
  loadTrainingExamplePreview,
  loadTrainingExamples,
} from './client'
import { encodeJsonl, encodeSftExample } from './encoding'
import type { TrainingExample } from './model'
import type { ExampleJob, ExtractionOptions } from './protocol'
import { setExampleSelection } from './registry'

type Source = { driveFileId: string } | { localUri: string }

/** AppKernel API: only explicit calls read history, open a preview or upload. */
export function createTrainingExamplesApi(deps: {
  localStore: () => LocalNotebooks | null
  driveStore: () => DriveNotebookStore | null
  openNotebook: (uri: string) => Promise<string>
  signal?: AbortSignal
}) {
  const jobFor = async (source: Source): Promise<ExampleJob> => {
    const store = deps.localStore()
    if (!store) throw new Error('Local notebook storage is unavailable')
    let uri: string
    if (
      source &&
      'driveFileId' in source &&
      /^[\w-]+$/.test(source.driveFileId)
    ) {
      const remoteUri = driveFileUrl(source.driveFileId)
      // Match canonical Drive IDs without exposing a local URI as portable identity.
      const records = await store.files.toArray()
      const record = records.find((record) => {
        try {
          return parseDriveItem(record.remoteId).id === source.driveFileId
        } catch {
          return false
        }
      })
      if (record?.operationLogRef) uri = record.id
      else {
        const remote = deps.driveStore()
        if (!remote)
          throw new Error(
            'Drive is unavailable; open the source notebook first'
          )
        const metadata = await remote.getMetadata(remoteUri)
        if (!metadata?.name?.endsWith('.runme'))
          throw new Error('Source must be a .runme notebook')
        uri = await store.importTrustedDriveSnapshot(remoteUri, metadata.name)
      }
    } else if (
      source &&
      'localUri' in source &&
      source.localUri.startsWith('local://file/')
    )
      uri = source.localUri
    else throw new Error('Expected source: { driveFileId } or { localUri }')
    // Capture the visible committed state before asking the read-only worker.
    await getNotebookDataController()
      .getNotebookData(uri)
      ?.flushPendingPersist()
    return store.trainingExampleJob(uri)
  }
  const preview = async (example: TrainingExample) => {
    if (!example?.source) throw new Error('Example must identify its source')
    return loadTrainingExamplePreview(
      await jobFor(example.source),
      example,
      deps.signal
    )
  }
  return {
    extract: async (args: { source: Source } & ExtractionOptions) => {
      if (
        args.sources &&
        (!Array.isArray(args.sources) ||
          args.sources.some(
            (s) => !['named-revision', 'cell-decision'].includes(s)
          ))
      )
        throw new Error('Unknown extraction source')
      if (
        args.syntheticReverse !== undefined &&
        typeof args.syntheticReverse !== 'boolean'
      )
        throw new Error('syntheticReverse must be boolean')
      return loadTrainingExamples(
        await jobFor(args.source),
        { sources: args.sources, syntheticReverse: args.syntheticReverse },
        deps.signal
      )
    },
    prepare: async (example: TrainingExample) => (await preview(example)).input,
    preview,
    show: async (examples: TrainingExample[]) => {
      if (!Array.isArray(examples) || !examples.length)
        throw new Error('Choose at least one example to inspect')
      if (new Set(examples.map((e) => e.id)).size !== examples.length)
        throw new Error('Duplicate example IDs')
      const jobs: Record<string, ExampleJob> = {}
      for (const example of examples) {
        if (!example.source) throw new Error('Example must identify its source')
        jobs[example.id] = await jobFor(example.source)
      }
      const job = jobs[examples[0].id]
      await deps.openNotebook(job.localUri)
      setExampleSelection(job.localUri, { examples, jobs })
      showWorkspaceDocument(
        getOperationLogSuggestionDocumentUri(job.localUri),
        { title: `Examples · ${job.name}`, afterUri: job.localUri }
      )
      return { count: examples.length, localUri: job.localUri }
    },
    encodeSftExample,
    encodeJsonl,
    uploadOpenAIJsonl: (args: Parameters<typeof uploadOpenAIJsonl>[0]) =>
      uploadOpenAIJsonl({ ...args, signal: deps.signal ?? args.signal }),
    submitTrainingJob: (args: Parameters<typeof submitTrainingJob>[0]) =>
      submitTrainingJob({ ...args, signal: deps.signal ?? args.signal }),
    getTrainingJob: (args: Parameters<typeof getTrainingJob>[0]) =>
      getTrainingJob({ ...args, signal: deps.signal ?? args.signal }),
    cancel: () => cancelTrainingExamples(),
    help: () =>
      [
        'await trainingExamples.extract({ source: { driveFileId }, sources?: ["named-revision", "cell-decision"], syntheticReverse?: false })',
        'await trainingExamples.prepare(example) // native content payloads; no labels or attribution',
        'await trainingExamples.preview(example) // exact input and diff',
        'await trainingExamples.show(examples) // inspect a recipe-selected list across documents',
        'trainingExamples.encodeSftExample(input, accepted); trainingExamples.encodeJsonl(rows)',
        'await trainingExamples.uploadOpenAIJsonl({ jsonl, filename, apiKey?, baseUrl? }) // saved Authentication Settings key by default',
        'await trainingExamples.submitTrainingJob({ job, apiKey?, baseUrl? }) // explicit POST; may incur costs; no retries',
        'await trainingExamples.getTrainingJob({ id, apiKey?, baseUrl? })',
        'trainingExamples.cancel() // stop page-local worker jobs',
        'No automatic generation, sidecars, Drive sync or training submission. Never paste secrets into notebook source.',
      ].join('\n'),
  }
}
