import {
  type GoogleDriveLocation,
  type GoogleDriveResource,
  driveApiUrl,
  driveResourceKeyHeader,
} from './googleDriveBrowser'

export type GoogleDriveResourcePath = {
  label: string
  complete: boolean
}

type Metadata = GoogleDriveLocation & { parents?: string[] }

const PATH_WORKERS = 6
const MAX_ANCESTORS = 100
const METADATA_TIMEOUT_MS = 10_000

/** Validates metadata before using API-provided names and parent links. */
function isMetadata(value: Partial<Metadata>, id: string): value is Metadata {
  return (
    value.id === id &&
    typeof value.name === 'string' &&
    (value.parents === undefined ||
      (Array.isArray(value.parents) &&
        value.parents.every((parent) => typeof parent === 'string')))
  )
}

/**
 * Enriches search rows without blocking selection. Each search owns its cache
 * of metadata promises, so siblings share in-flight reads and failed reads,
 * while subsequent searches retry failures and observe moves/renames. Workers
 * walk chains sequentially, bounding network concurrency without a nested queue.
 */
export async function resolveGoogleDriveResourcePaths(
  accessToken: string,
  resources: GoogleDriveResource[],
  roots: GoogleDriveLocation[],
  onPath: (id: string, path: GoogleDriveResourcePath) => void,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const rootNames = new Map(roots.map((root) => [root.id, root.name]))
  const metadata = new Map<string, Promise<Metadata | null>>()
  const driveNames = new Map<string, Promise<Metadata | null>>()
  const resourceKeys = new Map<string, string>()
  for (const resource of resources) {
    if (!resource.isShortcut) {
      metadata.set(resource.id, Promise.resolve(resource))
    }
    if (resource.resourceKey) {
      resourceKeys.set(resource.id, resource.resourceKey)
    }
  }

  /** A failed or timed-out read leaves a usable, explicitly partial path. */
  const readMetadata = async (
    id: string,
    kind: 'files' | 'drives'
  ): Promise<Metadata | null> => {
    if (signal.aborted) return null
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, METADATA_TIMEOUT_MS)
    try {
      const url = driveApiUrl(`drive/v3/${kind}/${encodeURIComponent(id)}`)
      url.searchParams.set(
        'fields',
        kind === 'files' ? 'id,name,parents,driveId,resourceKey' : 'id,name'
      )
      if (kind === 'files') url.searchParams.set('supportsAllDrives', 'true')
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...driveResourceKeyHeader({ id, resourceKey: resourceKeys.get(id) }),
        },
      })
      if (!response.ok) return null
      const value = (await response.json()) as Partial<Metadata>
      return value && isMetadata(value, id) ? value : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  /** Publish the promise before awaiting it to coalesce concurrent readers. */
  const getMetadata = (id: string, kind: 'files' | 'drives') => {
    const cache = kind === 'files' ? metadata : driveNames
    let pending = cache.get(id)
    if (!pending) {
      pending = readMetadata(id, kind)
      cache.set(id, pending)
    }
    return pending
  }

  /** Only a verified root makes a path complete; missing parents never do. */
  const resolve = async (
    resource: GoogleDriveResource
  ): Promise<GoogleDriveResourcePath> => {
    const names: string[] = []
    const seen = new Set<string>()
    let id: string | undefined = resource.id
    let driveId = resource.driveId
    for (let depth = 0; id && depth < MAX_ANCESTORS; depth += 1) {
      if (signal.aborted || seen.has(id)) break
      seen.add(id)
      const rootName = rootNames.get(id)
      if (rootName !== undefined) {
        return { label: [rootName, ...names].join(' / '), complete: true }
      }
      if (id === driveId) {
        const drive = await getMetadata(id, 'drives')
        if (drive) {
          return { label: [drive.name, ...names].join(' / '), complete: true }
        }
        break
      }
      const node = await getMetadata(id, 'files')
      if (!node) break
      // A shortcut can target a Shared Drive root without exposing driveId in
      // the search result. Discover that root from the target metadata first.
      if (node.driveId === id) {
        const drive = await getMetadata(id, 'drives')
        if (drive) {
          return { label: [drive.name, ...names].join(' / '), complete: true }
        }
        names.unshift(node.name)
        break
      }
      names.unshift(node.name)
      driveId = node.driveId ?? driveId
      id = node.parents?.[0]
    }
    // If even the target is unavailable, retain the visible search name.
    return {
      label: `… / ${(names.length ? names : [resource.name]).join(' / ')} (partial path)`,
      complete: false,
    }
  }

  let nextIndex = 0
  /** Each worker reports completed rows independently of slower ancestors. */
  const worker = async () => {
    while (!signal.aborted && nextIndex < resources.length) {
      const resource = resources[nextIndex++]
      const path = await resolve(resource)
      if (!signal.aborted) onPath(resource.id, path)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PATH_WORKERS, resources.length) }, worker)
  )
}
