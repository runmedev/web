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
      typeof source === 'object' &&
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
      typeof source === 'object' &&
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
  const inspect = async (example: TrainingExample) => {
    if (!example?.provenance?.source)
      throw new Error('Example must identify its source')
    return loadTrainingExamplePreview(example, deps.signal)
  }
  const show = async (examples: TrainingExample[]) => {
    if (!Array.isArray(examples) || !examples.length)
      throw new Error('Choose at least one example to inspect')
    if (new Set(examples.map((e) => e.id)).size !== examples.length)
      throw new Error('Duplicate example IDs')
    const jobs: Record<string, ExampleJob> = {}
    const sources = new Map<string, ExampleJob>()
    for (const example of examples) {
      const source = example.provenance?.source
      if (!source) throw new Error('Example must identify its source')
      const key = JSON.stringify(source)
      if (!sources.has(key)) sources.set(key, await jobFor(source))
      jobs[example.id] = sources.get(key)!
    }
    const job = jobs[examples[0].id]
    await deps.openNotebook(job.localUri)
    setExampleSelection(job.localUri, { examples, jobs })
    showWorkspaceDocument(getOperationLogSuggestionDocumentUri(job.localUri), {
      title: `Examples · ${job.name}`,
      afterUri: job.localUri,
    })
    return { count: examples.length, localUri: job.localUri }
  }
  const extractDetailed = async (
    args: { source: Source } & ExtractionOptions
  ) => {
    if (
      args.sources &&
      (!Array.isArray(args.sources) ||
        args.sources.some(
          (s) => !['named-revision', 'cell-decision', 'comment'].includes(s)
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
  }
  // The short CUJ returns an array; the object form retains diagnostics for
  // recipes choosing an extraction policy. Never silently hide deferred data.
  async function extract(reference: string): Promise<TrainingExample[]>
  async function extract(
    args: { source: Source } & ExtractionOptions
  ): ReturnType<typeof extractDetailed>
  async function extract(
    input: string | ({ source: Source } & ExtractionOptions)
  ) {
    if (typeof input !== 'string') return extractDetailed(input)
    let reference = input
    if (/^https?:/.test(reference))
      reference = new URL(reference).searchParams.get('doc') ?? reference
    const source: Source = reference.startsWith('local://file/')
      ? { localUri: reference }
      : { driveFileId: parseDriveItem(reference).id }
    const result = await extractDetailed({ source })
    if (result.issues.length)
      throw new Error(
        `Extraction needs review: ${result.issues.map((i) => i.reason).join('; ')}. Use extract({source}) to inspect diagnostics.`
      )
    return result.examples
  }
  return {
    extract,
    prepare: async (example: TrainingExample) => (await inspect(example)).input,
    preview: (examples: TrainingExample[]) => show(examples),
    show,
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
        'await trainingExamples.extract({ source: { driveFileId }, sources?: ["named-revision", "cell-decision", "comment"], syntheticReverse?: false })',
        'await trainingExamples.prepare(example) // native content payloads; no labels or attribution',
        'await trainingExamples.extract(notebookUrl) // cell examples; empty notebook is the initial baseline',
        'await trainingExamples.preview(examples) // open viewer with notebook/cell filters',
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
