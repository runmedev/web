import md5 from 'md5'

import { parseOperationLog } from '../operationLog/codec'
import {
  EXAMPLE_RULE_VERSION,
  type ExamplesHeader,
  extractExamples,
  serializeExamples,
} from './model'
import type { ExampleIndex, ExampleJob } from './protocol'

/** Filesystem boundary is injectable for deterministic corruption/race tests. */
export interface ExampleFiles {
  read(path: string): Promise<string | undefined>
  write(path: string, content: string): Promise<void>
  exclusive<T>(key: string, action: () => Promise<T>): Promise<T>
}

/** Rebuild from source history, with a quick publication check under the source
 * writer's lock. Failed parsing/generation never truncates the previous index.
 */
export async function generateExampleIndex(
  files: ExampleFiles,
  job: ExampleJob
): Promise<ExampleIndex> {
  const sidecarPath = job.sourcePath + '.examples'
  return files.exclusive('runme:examples:' + sidecarPath, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const source = await files.read(job.sourcePath)
      if (source === undefined)
        throw new Error('Source notebook is unavailable in OPFS')
      const parsed = parseOperationLog(source)
      const header: ExamplesHeader = {
        record_type: 'runme.examples',
        format_version: 1,
        source: {
          notebookId: parsed.header.notebook_id,
          localUri: job.localUri,
          ...(job.driveFileId ? { driveFileId: job.driveFileId } : {}),
        },
        ruleVersion: EXAMPLE_RULE_VERSION,
        sourceChecksum: md5(source),
      }
      const previous = await files.read(sidecarPath)
      if (previous) {
        const old = JSON.parse(previous.split('\n')[0]) as ExamplesHeader
        if (
          old.record_type !== 'runme.examples' ||
          old.format_version !== 1 ||
          old.source?.notebookId !== header.source.notebookId ||
          old.source?.localUri !== header.source.localUri
        )
          throw new Error(
            'Existing examples file has an unknown schema or different source; preserved'
          )
      }
      const extracted = extractExamples(
        parsed.operations,
        parsed.header.notebook_id
      )
      const document = serializeExamples(header, extracted.examples)
      const saved = await files.exclusive(
        'runme:operation-log:' + job.sourcePath,
        async () => {
          if ((await files.read(job.sourcePath)) !== source) return false
          if (document !== previous) await files.write(sidecarPath, document)
          return true
        }
      )
      if (saved) return { header, sidecarPath, ...extracted }
    }
    throw new Error(
      'Notebook changed during example generation; retry when edits settle'
    )
  })
}

/** OPFS writable streams stage replacement until close. Web Locks are required
 * here: an in-process fallback cannot coordinate two tabs' dedicated workers.
 */
export const browserExampleFiles: ExampleFiles = {
  async read(path) {
    try {
      const handle = await fileHandle(path, false)
      return (await handle.getFile()).text()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError')
        return undefined
      throw error
    }
  },
  async write(path, content) {
    const writable = await (await fileHandle(path, true)).createWritable()
    try {
      await writable.write(content)
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
  },
  async exclusive(key, action) {
    if (!navigator.locks?.request)
      throw new Error('Example generation requires Web Locks')
    return navigator.locks.request(key, action)
  },
}

/** Restrict worker file access to the app's existing notebook directory layout. */
async function fileHandle(
  path: string,
  create: boolean
): Promise<FileSystemFileHandle> {
  const parts = path.split('/')
  if (
    parts.length !== 4 ||
    parts[0] !== 'runme' ||
    parts[1] !== 'notebooks' ||
    !parts[2] ||
    parts[2] === '..' ||
    !['document.runme', 'document.runme.examples'].includes(parts[3])
  )
    throw new Error('Invalid notebook examples path')
  let directory = await navigator.storage.getDirectory()
  for (const part of parts.slice(0, -1))
    directory = await directory.getDirectoryHandle(part)
  return directory.getFileHandle(parts[3], { create })
}
