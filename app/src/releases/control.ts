import { releaseTransaction } from './releaseDatabase'

/** Loader protocol 1 is independent of notebook schemas and application builds. */
export const CONTROL_DB = 'runme-release-control'
export const OWNER_LOCK = 'runme-storage-owner-lifetime-v1'
export const RELEASE_CAPABILITIES = [
  'durable-prepare-v1',
  'epoch-fence-v1',
  'owner-lock-v1',
]
export const STORAGE_COMPATIBILITY = 'runme-schema9-oplog2-payload1-console1'
export type Selection =
  | { kind: 'channel'; name: 'stable' | 'latest' }
  | { kind: 'pinned'; releaseId: string }
export type Manifest = {
  format: 1
  releaseId: string
  webCommit: string
  buildId: string
  buildInputsDigest: string
  publishedAt: string
  requiredCapabilities: string[]
  testedRollbackTargets: string[]
  launcherProtocol: { min: number; max: number }
  appEntry: string
  styles: string[]
  owner: { buildId: string; entry: string; rpcMin: number; rpcMax: number }
  storageCompatibilityId: string
  assets: {
    path: string
    sha256: string
    bytes: number
    requiredOffline: boolean
  }[]
}
export type Active = { manifest: Manifest; epoch: number }
export type CommitReference = { uri: string; heads: string[] }
export type Participant = {
  epoch: number
  ready?: CommitReference[]
  error?: string
}
export type Transition = {
  id: string
  from?: Active
  target: Manifest
  epoch: number
  phase: 'prepare' | 'handoff'
  participants: Record<string, Participant>
}
export type Control = {
  format: 1
  selection: Selection
  active?: Active
  previous?: Active
  candidate?: Manifest
  transition?: Transition
  completedTransition?: Transition
  ownerStartup?: {
    releaseId: string
    epoch: number
    phase: 'initializing' | 'ready'
  }
  tabs: Record<string, { epoch: number; releaseId: string; label?: string }>
  healthy?: string
  emergencyRestart?: { epoch: number; id: string }
  ownerError?: { transitionId?: string; message: string }
}

/** One transaction serializes admission, readiness and activation. Callbacks must
 * be synchronous: no network/cache awaits may outlive an IndexedDB transaction.
 * Close every connection so a suspended tab cannot block a future loader schema.
 */
export async function control<T>(
  mutate: (state: Control) => T,
  write = true
): Promise<T> {
  return releaseTransaction(CONTROL_DB, write, (value) => {
    const state: Control = (value as Control | undefined) ?? {
      format: 1,
      selection: { kind: 'channel', name: 'stable' },
      tabs: {},
    }
    if (state.format !== 1)
      throw new Error('Unsupported release-control format')
    const result = mutate(state)
    return { state, result }
  })
}

export const readControl = () => control((state) => state, false)
export const releasePrefix = (id: string) => `/version/${id}/`
export const cacheName = (id: string) => `runme-release-v1-${id}`
// Separate from the legacy full-offline completion marker. Older loaders still
// require every asset; they cannot mistake startup readiness for a complete cache.
export const startupMarker = (id: string) => `/__runme-startup/${id}`
type AssetScope = 'all' | 'startup' | 'fonts'

/** Only passive font resources may be deferred. Executable and style entrypoints
 * remain mandatory even if a malformed manifest gives them a font extension.
 */
function scopedAssets(
  manifest: Manifest,
  scope: AssetScope
): Manifest['assets'] {
  const entries = new Set([
    manifest.appEntry,
    manifest.owner.entry,
    ...manifest.styles,
  ])
  return manifest.assets.filter((asset) => {
    const font =
      /\.(woff2?|ttf|otf)$/i.test(asset.path) && !entries.has(asset.path)
    return scope === 'all' || (scope === 'fonts' ? font : !font)
  })
}
export const releaseIdValid = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{40}-[a-f0-9]{64}$/.test(id)

/** Reject archives and manifests that could escape their immutable namespace. */
export function validateManifest(value: unknown): Manifest {
  const m = value as Manifest
  if (
    !m ||
    m.format !== 1 ||
    !releaseIdValid(m.releaseId) ||
    m.releaseId !== `${m.webCommit}-${m.buildId}` ||
    m.buildInputsDigest !== m.buildId ||
    !Number.isFinite(Date.parse(m.publishedAt)) ||
    m.owner?.buildId !== m.buildId ||
    !Array.isArray(m.requiredCapabilities) ||
    m.requiredCapabilities.some((c) => !RELEASE_CAPABILITIES.includes(c)) ||
    RELEASE_CAPABILITIES.some((c) => !m.requiredCapabilities.includes(c)) ||
    !Array.isArray(m.testedRollbackTargets) ||
    m.testedRollbackTargets.some((id) => !releaseIdValid(id)) ||
    !Number.isInteger(m.launcherProtocol?.min) ||
    !Number.isInteger(m.launcherProtocol?.max) ||
    m.launcherProtocol?.min > 1 ||
    m.launcherProtocol?.max < 1 ||
    !m.launcherProtocol ||
    m.storageCompatibilityId !== STORAGE_COMPATIBILITY ||
    !Number.isInteger(m.owner?.rpcMin) ||
    !Number.isInteger(m.owner?.rpcMax) ||
    m.owner?.rpcMin > 8 ||
    m.owner?.rpcMax < 8 ||
    !Array.isArray(m.assets) ||
    !m.assets.length ||
    !Array.isArray(m.styles)
  )
    throw new Error(
      'Release does not support this loader or current storage format'
    )
  const paths = new Set<string>()
  for (const asset of m.assets) {
    if (
      !asset ||
      typeof asset.path !== 'string' ||
      !/^[a-zA-Z0-9_@+.,() /-]+$/.test(asset.path) ||
      asset.path.startsWith('/') ||
      asset.path.split('/').some((p) => !p || p === '.' || p === '..') ||
      paths.has(asset.path) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      asset.requiredOffline !== true ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0
    )
      throw new Error('Invalid release asset inventory')
    paths.add(asset.path)
  }
  if (
    ![m.appEntry, m.owner.entry, ...m.styles].every((path) => paths.has(path))
  )
    throw new Error('Release entry is missing from inventory')
  return m
}

/** Hash exact response bytes; HTTP errors/redirected login pages are never code. */
export async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
}

/** Files verified so far, including reusable files from an interrupted download. */
export interface ReleaseProgress {
  completed: number
  total: number
}

/** Bound network and hashing work. Drain in-flight operations on failure before
 * releasing the download lock, so a retry cannot race writes from a failed run.
 */
async function processAssets(
  assets: Manifest['assets'],
  process: (asset: Manifest['assets'][number]) => Promise<void>,
  progress?: (value: ReleaseProgress) => void
): Promise<void> {
  let next = 0
  let completed = 0
  let failed = false
  let failure: unknown
  progress?.({ completed, total: assets.length })
  await Promise.all(
    Array.from({ length: Math.min(6, assets.length) }, async () => {
      while (!failed && next < assets.length) {
        const asset = assets[next++]
        try {
          await process(asset)
          progress?.({ completed: ++completed, total: assets.length })
        } catch (error) {
          if (!failed) failure = error
          failed = true
        }
      }
    })
  )
  if (failed) throw failure
}

/** Stage verified files into a release-specific cache. Startup and full-offline
 * readiness have distinct markers; each is written after its required files.
 * Activation rechecks the selected scope because storage can be evicted later.
 */
export async function stage(
  manifest: Manifest,
  progress?: (value: ReleaseProgress) => void,
  scope: AssetScope = 'all'
): Promise<void> {
  validateManifest(manifest)
  await navigator.locks.request(
    `runme-release-download-${manifest.releaseId}-${scope}`,
    async () => {
      const cache = await caches.open(cacheName(manifest.releaseId))
      await processAssets(
        scopedAssets(manifest, scope),
        async (asset) => {
          const url = releasePrefix(manifest.releaseId) + asset.path
          const old = await cache.match(url, { ignoreVary: true })
          if (old && (await validResponse(old, asset))) return
          const response = await fetch(url, {
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
          })
          if (!(await validResponse(response.clone(), asset)))
            throw new Error(`Download verification failed: ${asset.path}`)
          await cache.put(url, response)
        },
        progress
      )
      // Background fonts never certify offline readiness without checking the
      // required code too. Concurrent writes contain identical verified bytes.
      if (scope === 'fonts') await verifyCache(manifest)
      await cache.put(
        scope === 'startup'
          ? startupMarker(manifest.releaseId)
          : releasePrefix(manifest.releaseId) + 'release.json',
        new Response(JSON.stringify(manifest), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
  )
}

async function validResponse(
  response: Response,
  asset: Manifest['assets'][number]
): Promise<boolean> {
  if (!response.ok || response.type === 'opaque') return false
  const bytes = await response.arrayBuffer()
  return (
    bytes.byteLength === asset.bytes && (await digest(bytes)) === asset.sha256
  )
}

export async function verifyCache(
  manifest: Manifest,
  progress?: (value: ReleaseProgress) => void,
  scope: AssetScope = 'all'
): Promise<void> {
  validateManifest(manifest)
  const cache = await caches.open(cacheName(manifest.releaseId))
  await processAssets(
    scopedAssets(manifest, scope),
    async (asset) => {
      const response = await cache.match(
        releasePrefix(manifest.releaseId) + asset.path,
        { ignoreVary: true }
      )
      if (!response || !(await validResponse(response, asset)))
        throw new Error(
          `Release cache incomplete: ${asset.path}. Reconnect and retry download.`
        )
    },
    progress
  )
}

/** Validate selections from URLs, UI and the automation bridge before persistence. */
export function validateSelection(value: Selection): Selection {
  if (value?.kind === 'channel' && ['stable', 'latest'].includes(value.name))
    return value
  if (value?.kind === 'pinned' && releaseIdValid(value.releaseId)) return value
  throw new Error('Choose stable, latest, or an exact full release ID')
}

/** Load a pointer with explicit revalidation; pins never consult channel state. */
export async function discover(selection: Selection): Promise<Manifest> {
  validateSelection(selection)
  let id: string, expected: string | undefined
  if (selection.kind === 'pinned') id = selection.releaseId
  else {
    const response = await fetch(`/channels/${selection.name}.json`, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    })
    if (!response.ok) throw new Error('Channel lookup failed')
    const pointer = await response.json()
    if (
      pointer.format !== 1 ||
      !Number.isSafeInteger(pointer.generation) ||
      !/^[a-f0-9]{64}$/.test(pointer.manifestSha256)
    )
      throw new Error('Invalid channel pointer')
    id = pointer.releaseId
    expected = pointer.manifestSha256
  }
  if (!releaseIdValid(id)) throw new Error('Invalid release ID')
  const response = await fetch(releasePrefix(id) + 'release.json', {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  })
  if (!response.ok) throw new Error('Release manifest unavailable')
  const bytes = await response.arrayBuffer()
  if (expected && (await digest(bytes)) !== expected)
    throw new Error('Release manifest checksum mismatch')
  const manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)))
  if (manifest.releaseId !== id) throw new Error('Release identity mismatch')
  return manifest
}

/** Delete only unreferenced app caches under the same lock as download/selection.
 * Loader caches have an independent lifetime and are never removed here.
 */
export async function pruneUnusedCaches(): Promise<number> {
  return navigator.locks.request('runme-release-cache', async () => {
    const state = await readControl()
    const keep = new Set([
      state.active?.manifest.releaseId,
      state.previous?.manifest.releaseId,
      state.candidate?.releaseId,
      state.healthy,
      state.transition?.from?.manifest.releaseId,
      state.transition?.target.releaseId,
      state.selection.kind === 'pinned' ? state.selection.releaseId : undefined,
      ...Object.values(state.tabs).map((tab) => tab.releaseId),
    ])
    let removed = 0
    for (const name of await caches.keys()) {
      if (!name.startsWith('runme-release-v1-')) continue
      const id = name.slice('runme-release-v1-'.length)
      if (releaseIdValid(id) && !keep.has(id) && (await caches.delete(name)))
        removed++
    }
    return removed
  })
}
