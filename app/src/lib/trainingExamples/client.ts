import { appLogger } from '../logging/runtime'
import type { TrainingExample } from './model'
import type {
  ExampleIndex,
  ExampleJob,
  ExamplePreview,
  ExampleRequest,
  ExampleResponse,
} from './protocol'

export const automaticExamplesEnabled =
  import.meta.env.VITE_TRAINING_EXAMPLES === 'true'
let worker: Worker | undefined
let nextId = 0
const pending = new Map<
  number,
  {
    resolve: (response: ExampleResponse) => void
    reject: (error: Error) => void
  }
>()
const scheduled = new Map<string, ReturnType<typeof setTimeout>>()
const running = new Set<string>()
const trailing = new Map<string, ExampleJob>()

/** One dedicated worker per page; failures are independent of notebook saves. */
function request(
  request:
    | Omit<Extract<ExampleRequest, { kind: 'generate' }>, 'id'>
    | Omit<Extract<ExampleRequest, { kind: 'preview' }>, 'id'>
): Promise<ExampleResponse> {
  if (!worker) {
    worker = new Worker(new URL('./examples.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = ({ data }: MessageEvent<ExampleResponse>) => {
      const job = pending.get(data.id)
      pending.delete(data.id)
      if (data.kind === 'error') job?.reject(new Error(data.error))
      else job?.resolve(data)
    }
    worker.onerror = () => {
      worker?.terminate()
      worker = undefined
      for (const job of pending.values())
        job.reject(new Error('Example worker failed; retry generation'))
      pending.clear()
    }
  }
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      worker!.postMessage({ ...request, id })
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

/** Explicit viewer refresh also works when automatic generation is disabled. */
export async function loadTrainingExamples(
  job: ExampleJob
): Promise<ExampleIndex> {
  const response = await request({ kind: 'generate', job })
  if (response.kind !== 'generate')
    throw new Error('Unexpected example worker response')
  return response.result
}

/** Reconstruct one example off-thread; labels and provenance never enter input. */
export async function loadTrainingExamplePreview(
  job: ExampleJob,
  example: TrainingExample
): Promise<ExamplePreview> {
  const response = await request({ kind: 'preview', job, example })
  if (response.kind !== 'preview')
    throw new Error('Unexpected example worker response')
  return response.result
}

/** Coalesce notifications; source history is the durable trigger on next open. */
export function scheduleTrainingExamples(job: ExampleJob): void {
  if (!automaticExamplesEnabled) return
  clearTimeout(scheduled.get(job.localUri))
  scheduled.set(
    job.localUri,
    setTimeout(() => {
      scheduled.delete(job.localUri)
      if (running.has(job.localUri)) {
        trailing.set(job.localUri, job)
        return
      }
      running.add(job.localUri)
      void loadTrainingExamples(job)
        .then((result) => {
          appLogger.info(
            'Training examples saved locally (Drive upload is not implemented)',
            {
              attrs: {
                scope: 'training.examples',
                localUri: job.localUri,
                count: result.examples.length,
              },
            }
          )
        })
        .catch((error) => {
          appLogger.error('Training example generation failed', {
            attrs: {
              scope: 'training.examples',
              localUri: job.localUri,
              error: String(error),
            },
          })
        })
        .finally(() => {
          running.delete(job.localUri)
          const next = trailing.get(job.localUri)
          trailing.delete(job.localUri)
          if (next) scheduleTrainingExamples(next)
        })
    }, 500)
  )
}
