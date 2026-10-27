// Chromium stores large IndexedDB values in separate files. Keep each recovered
// settings value small; commit the header and every chunk in one transaction.
const CHUNK_SIZE = 8192
const MAX_CHUNKS = 4096

type Header = { encoding: 'runme-control-json-chunks-v1'; count: number }

/** Read legacy values unchanged, or assemble bounded chunks in the same tx. */
export function readControlValue(
  table: IDBObjectStore,
  value: unknown,
  done: (value: unknown) => void,
  failed: (error: unknown) => void,
  progress?: (read: number, total: number) => void
): void {
  const header = value as Partial<Header> | undefined
  if (header?.encoding !== 'runme-control-json-chunks-v1') {
    done(value)
    return
  }
  const count = header.count
  if (!Number.isInteger(count) || !count || count < 1 || count > MAX_CHUNKS) {
    failed(new Error('Invalid release settings chunk inventory'))
    return
  }
  const chunks: string[] = new Array(count)
  let remaining = count
  progress?.(0, count)
  for (let index = 0; index < count; index++) {
    const request = table.get(`control-chunk-${index}`)
    request.onerror = () => failed(request.error)
    request.onsuccess = () => {
      if (
        typeof request.result !== 'string' ||
        request.result.length > CHUNK_SIZE
      ) {
        failed(new Error('Missing or invalid release settings chunk'))
        return
      }
      chunks[index] = request.result
      remaining--
      progress?.(count - remaining, count)
      if (remaining === 0) {
        try {
          done(JSON.parse(chunks.join('')))
        } catch (error) {
          failed(error)
        }
      }
    }
  }
}

/** Only repaired databases use chunks; healthy v1 stores stay compatible with
 * existing workers until those workers have drained and released ownership.
 */
export function writeControlValue(
  table: IDBObjectStore,
  value: unknown,
  chunked: boolean,
  failed: (error: unknown) => void
): void {
  const put = (value: unknown, key: string) => {
    const request = table.put(value, key)
    request.onerror = () => failed(request.error)
  }
  if (!chunked) {
    put(value, 'control')
    return
  }
  const json = JSON.stringify(value)
  const count = Math.ceil(json.length / CHUNK_SIZE)
  if (count > MAX_CHUNKS)
    throw new Error('Release settings exceed the supported size')
  for (let index = 0; index < count; index++)
    put(
      json.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
      `control-chunk-${index}`
    )
  put(
    { encoding: 'runme-control-json-chunks-v1', count } satisfies Header,
    'control'
  )
}
