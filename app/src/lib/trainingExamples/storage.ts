import md5 from 'md5'

import { parseOperationLog } from '../operationLog/codec'
import { EXAMPLE_RULE_VERSION, extractExamples } from './model'
import type { ExampleIndex, ExampleJob, ExtractionOptions } from './protocol'

/** Read-only boundary: extraction cannot create, replace or remove any file. */
export interface ExampleFiles {
  read(path: string): Promise<string | undefined>
}

/** One immutable read per explicit extraction. No cache files or save hooks. */
export async function generateExampleIndex(
  files: ExampleFiles,
  job: ExampleJob,
  options: ExtractionOptions = {}
): Promise<ExampleIndex> {
  const source = await files.read(job.sourcePath)
  if (source === undefined)
    throw new Error('Source notebook is unavailable in OPFS')
  const parsed = parseOperationLog(source)
  const extracted = extractExamples(
    parsed.operations,
    job.driveFileId ?? job.localUri,
    options
  )
  return {
    sourceChecksum: md5(source),
    ruleVersion: EXAMPLE_RULE_VERSION,
    ...extracted,
    examples: extracted.examples.map((example) => ({
      ...example,
      provenance: {
        ...example.provenance,
        source: job.driveFileId
          ? { driveFileId: job.driveFileId }
          : { localUri: job.localUri },
      },
    })),
  }
}

/** Workers only read existing notebook journals; no writable handle is exposed. */
export const browserExampleFiles: ExampleFiles = {
  async read(path) {
    const parts = path.split('/')
    if (
      parts.length !== 4 ||
      parts[0] !== 'runme' ||
      parts[1] !== 'notebooks' ||
      !parts[2] ||
      parts[2] === '..' ||
      parts[3] !== 'document.runme'
    ) {
      throw new Error('Invalid notebook source path')
    }
    try {
      let directory = await navigator.storage.getDirectory()
      for (const part of parts.slice(0, -1))
        directory = await directory.getDirectoryHandle(part)
      return (await (await directory.getFileHandle(parts[3])).getFile()).text()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError')
        return undefined
      throw error
    }
  },
}
