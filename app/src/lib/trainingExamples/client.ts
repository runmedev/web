import type { TrainingExample } from './model'
import type {
  ExampleIndex,
  ExampleJob,
  ExamplePreview,
  ExampleRequest,
  ExampleResponse,
  ExtractionOptions,
} from './protocol'

let worker: Worker | undefined
let nextId = 0
const pending = new Map<
  number,
  {
    resolve: (response: ExampleResponse) => void
    reject: (error: Error) => void
  }
>()

/** Explicit jobs share one dedicated worker. There are no save/open triggers. */
function request(
  request:
    | Omit<Extract<ExampleRequest, { kind: 'generate' }>, 'id'>
    | Omit<Extract<ExampleRequest, { kind: 'preview' }>, 'id'>,
  signal?: AbortSignal
): Promise<ExampleResponse> {
  if (signal?.aborted)
    return Promise.reject(new Error('Example request cancelled'))
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
    worker.onerror = () =>
      cancelTrainingExamples('Example worker failed; retry extraction')
  }
  const id = ++nextId
  return new Promise<ExampleResponse>((resolve, reject) => {
    const abort = () => {
      pending.delete(id)
      signal?.removeEventListener('abort', abort)
      reject(new Error('Example request cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', abort)
    pending.set(id, {
      resolve: (response) => {
        cleanup()
        resolve(response)
      },
      reject: (error) => {
        cleanup()
        reject(error)
      },
    })
    try {
      worker!.postMessage({ ...request, id })
    } catch (error) {
      pending.delete(id)
      cleanup()
      reject(error)
    }
  })
}

/** Cancel all page-local work, including CPU work; a later call creates a worker. */
export function cancelTrainingExamples(
  message = 'Example extraction cancelled'
): void {
  worker?.terminate()
  worker = undefined
  for (const job of pending.values()) job.reject(new Error(message))
  pending.clear()
}

/** Extract on demand into memory, without writing an examples sidecar. */
export async function loadTrainingExamples(
  job: ExampleJob,
  options?: ExtractionOptions,
  signal?: AbortSignal
): Promise<ExampleIndex> {
  const response = await request(
    { kind: 'generate', job, ...(options ? { options } : {}) },
    signal
  )
  if (response.kind !== 'generate')
    throw new Error('Unexpected example worker response')
  return response.result
}

/** Reconstruct the immutable endpoints off-thread, not the current editor head. */
export async function loadTrainingExamplePreview(
  example: TrainingExample,
  signal?: AbortSignal
): Promise<ExamplePreview> {
  const response = await request({ kind: 'preview', example }, signal)
  if (response.kind !== 'preview')
    throw new Error('Unexpected example worker response')
  return response.result
}
