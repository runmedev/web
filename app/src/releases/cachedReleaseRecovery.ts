import {
  type Manifest,
  releaseIdValid,
  releasePrefix,
  startupMarker,
  validateManifest,
} from './control'

/** Enumerate complete inventories without preferences or network access. A
 * cache name alone may contain only launcher files or an interrupted download. */
export async function cachedReleases(): Promise<Manifest[]> {
  const releases: Manifest[] = []
  for (const name of await caches.keys()) {
    if (!name.startsWith('runme-release-v1-')) continue
    const id = name.slice('runme-release-v1-'.length)
    if (!releaseIdValid(id)) continue
    try {
      const cache = await caches.open(name)
      const response =
        (await cache.match(releasePrefix(id) + 'release.json')) ??
        (await cache.match(startupMarker(id)))
      if (!response) continue
      const manifest = validateManifest(await response.json())
      if (manifest.releaseId === id) releases.push(manifest)
    } catch {
      // A corrupt inventory must not hide other usable cached releases.
    }
  }
  return releases.sort(
    (a, b) =>
      Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
      a.releaseId.localeCompare(b.releaseId)
  )
}

/** Activation verifies actual cached bytes and worker compatibility, then uses
 * the normal exclusive owner lock. Try older publications if a candidate fails. */
export async function tryCachedReleases(
  activate: (manifest: Manifest) => Promise<void>,
  rejected: (manifest: Manifest, error: unknown) => void
): Promise<void> {
  let lastError: unknown
  for (const manifest of await cachedReleases()) {
    try {
      await activate(manifest)
      return
    } catch (error) {
      lastError = error
      rejected(manifest, error)
    }
  }
  throw (
    lastError ??
    new Error(
      'No usable cached application release. Connect and choose a release below.'
    )
  )
}
