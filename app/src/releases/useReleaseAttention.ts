import { useEffect, useState } from 'react'

import { type ReleaseAttention, releaseAttention } from './releaseAttention'
import './runtime'

/** Current launchers publish a memory-only snapshot, including read failures.
 * Older launchers fall back to bounded, non-overlapping settings reads.
 */
export function useReleaseAttention(): ReleaseAttention | undefined {
  const api = window.runmeVersions
  const [attention, setAttention] = useState<ReleaseAttention>()
  useEffect(() => {
    if (!api) return
    let disposed = false
    let reading = false
    const refresh = async () => {
      if (disposed || reading) return
      if (api.attention) {
        setAttention(api.attention())
        return
      }
      reading = true
      try {
        const state = await api.get()
        if (!disposed)
          setAttention(
            releaseAttention(
              state,
              window.runmeRelease?.active.manifest.releaseId
            )
          )
      } catch {
        if (!disposed)
          setAttention({
            kind: 'error',
            message: 'Version information needs attention',
          })
      } finally {
        reading = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener('runme-release-change', refresh)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('runme-release-change', refresh)
    }
  }, [api])
  return attention
}
