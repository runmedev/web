/** A shared lifetime lease protects the app's lazy assets without persisting a
 * per-tab record. The browser releases it even when a document crashes. Callers
 * acquire it under runme-release-cache before verifying/importing app assets.
 */
export function holdReleaseCache(releaseId: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(
        releaseCacheLock(releaseId),
        { mode: 'shared' },
        () => new Promise<void>((release) => resolve(release))
      )
      .catch(reject)
  })
}

/** Cleanup takes the exclusive counterpart without waiting on an open tab. */
export const releaseCacheLock = (releaseId: string): string =>
  `runme-release-assets-${releaseId}`
