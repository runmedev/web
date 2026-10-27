/** The launcher updates independently of app selection. This wire format is a
 * permanent bootstrap contract: newer launchers must support protocol 1 and
 * the existing release database/worker protocols before being published here. */
export interface LauncherDescriptor {
  format: 1
  protocol: 1
  releaseId: string
  entry: string
  assets: { path: string; sha256: string; bytes: number }[]
}
export const LAUNCHER_CACHE = 'runme-launcher-bootstrap-v1'
export const LAUNCHER_POINTER = '/__runme-launcher-current'
const idPattern = /^[a-f0-9]{40}-[a-f0-9]{64}$/

/** Reject incompatible descriptors and paths outside immutable release assets. */
export function launcherDescriptor(value: unknown): LauncherDescriptor {
  const d = value as LauncherDescriptor
  if (
    !d ||
    d.format !== 1 ||
    d.protocol !== 1 ||
    !idPattern.test(d.releaseId) ||
    !Array.isArray(d.assets) ||
    !d.assets.length ||
    d.assets.length > 100 ||
    !d.assets.some((a) => a.path === d.entry)
  )
    throw new Error('Unsupported launcher descriptor')
  const paths = new Set<string>()
  for (const a of d.assets) {
    if (
      !a ||
      typeof a.path !== 'string' ||
      !/^[a-zA-Z0-9_./-]+\.js$/.test(a.path) ||
      a.path.startsWith('/') ||
      a.path.split('/').some((p) => !p || p === '.' || p === '..') ||
      paths.has(a.path) ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 0 ||
      a.bytes > 10_000_000
    )
      throw new Error('Invalid launcher asset')
    paths.add(a.path)
  }
  return d
}

/** Bound the whole operation, including body reads and CacheStorage (which has
 * no abort API). A late result never starts a second launcher. */
export async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Launcher check timed out'))
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer!)
  }
}

/** Validate cached and downloaded bytes alike; a marker is not proof against
 * subsequent eviction or cache corruption. */
async function verifyLauncherAsset(
  response: Response,
  asset: LauncherDescriptor['assets'][number]
) {
  const bytes = await response.arrayBuffer()
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
  if (
    !response.ok ||
    bytes.byteLength !== asset.bytes ||
    digest !== asset.sha256
  )
    throw new Error('Launcher verification failed')
}

/** Only mark a launcher cached after every static module has been verified.
 * Partial immutable writes are safe; they never constitute a completion marker.
 * The release cache is understood by both historical and current loader workers. */
async function writeLauncherCache(
  d: LauncherDescriptor,
  signal: AbortSignal
): Promise<void> {
  const cache = await caches.open(`runme-release-v1-${d.releaseId}`)
  for (const asset of d.assets) {
    signal.throwIfAborted()
    const url = `/version/${d.releaseId}/${asset.path}`
    const response =
      (await cache.match(url)) ??
      (await fetch(url, { cache: 'no-store', redirect: 'error', signal }))
    if (!response.ok) throw new Error('Launcher asset unavailable')
    await verifyLauncherAsset(response.clone(), asset)
    signal.throwIfAborted()
    await cache.put(url, response)
  }
  signal.throwIfAborted()
  const index = await caches.open(LAUNCHER_CACHE)
  signal.throwIfAborted()
  await index.put(LAUNCHER_POINTER, new Response(JSON.stringify(d)))
}

/** Serialize cache publication with explicit pruning, without taking the
 * notebook owner lock. Abort a queued cache lock when the online deadline ends. */
export function cacheLauncher(
  d: LauncherDescriptor,
  signal: AbortSignal
): Promise<void> {
  return navigator.locks.request(
    'runme-release-cache',
    { mode: 'shared', signal },
    () => writeLauncherCache(d, signal)
  )
}

/** Prefer current published launcher, then a complete cached snapshot, then the
 * shell's precached launcher. No IndexedDB, app selection, or owner lock needed. */
export async function selectLauncher(
  fallback: LauncherDescriptor,
  report: (message: string) => void,
  timeoutMs = 4000
): Promise<{ descriptor: LauncherDescriptor; source: string }> {
  try {
    const descriptor = await bounded(async (signal) => {
      const response = await fetch('/launcher.json', {
        cache: 'no-store',
        redirect: 'error',
        signal,
      })
      if (!response.ok) throw new Error('Latest launcher unavailable')
      const d = launcherDescriptor(await response.json())
      await cacheLauncher(d, signal)
      return d
    }, timeoutMs)
    return { descriptor, source: 'latest' }
  } catch (error) {
    report(error instanceof Error ? error.message : 'Launcher check failed')
  }
  try {
    const descriptor = await bounded(async () => {
      const index = await caches.open(LAUNCHER_CACHE)
      const response = await index.match(LAUNCHER_POINTER)
      if (!response) throw new Error('No cached launcher')
      const d = launcherDescriptor(await response.json())
      // Pruning/eviction may remove assets after the completion marker was saved.
      const cache = await caches.open(`runme-release-v1-${d.releaseId}`)
      for (const asset of d.assets) {
        const cached = await cache.match(
          `/version/${d.releaseId}/${asset.path}`
        )
        if (!cached) throw new Error('Cached launcher incomplete')
        await verifyLauncherAsset(cached, asset)
      }
      return d
    }, 1000)
    return { descriptor, source: 'cached' }
  } catch {
    return { descriptor: launcherDescriptor(fallback), source: 'bundled' }
  }
}
