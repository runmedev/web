import { parseOperationLog } from '../operationLog/codec'
import { previewExample } from './preview'
import type { ExampleRequest, ExampleResponse } from './protocol'
import { browserExampleFiles, generateExampleIndex } from './storage'

// Explicit narrow worker surface avoids adding WebWorker globals to the app's
// DOM tsconfig. Jobs run sequentially so a large history cannot flood memory.
const worker = self as unknown as {
  onmessage: (event: MessageEvent<ExampleRequest>) => void
  postMessage: (response: ExampleResponse) => void
}
let tail = Promise.resolve()
worker.onmessage = ({ data }) => {
  tail = tail.then(async () => {
    try {
      if (data.kind === 'generate') {
        worker.postMessage({
          id: data.id,
          kind: 'generate',
          result: await generateExampleIndex(browserExampleFiles, data.job),
        })
      } else {
        const source = await browserExampleFiles.read(data.job.sourcePath)
        if (!source) throw new Error('Source notebook is unavailable')
        const parsed = parseOperationLog(source)
        // Historical naming can repartition the index. The viewer's frozen
        // revision pair remains inspectable until its next explicit refresh.
        worker.postMessage({
          id: data.id,
          kind: 'preview',
          result: previewExample(parsed.operations, data.example),
        })
      }
    } catch (error) {
      worker.postMessage({ id: data.id, kind: 'error', error: String(error) })
    }
  })
}
