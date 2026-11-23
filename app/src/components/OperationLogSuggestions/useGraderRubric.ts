import { useEffect, useState } from 'react'

import { sha256Text } from '../../lib/markdown/renderedMarkdownProjection'
import { appState } from '../../lib/runtime/AppState'
import { readRubric } from '../../lib/suggestionGrader'

/** Re-read committed instructions before reusing a prediction, including after a
 * background-tab edit. Ignore reads superseded by a newer save or selection. */
export function useGraderRubric(
  uri: string,
  candidate: unknown,
  active: boolean
) {
  const [snapshot, setSnapshot] = useState<{
    uri: string
    candidate: unknown
    text?: string
    digest?: string
    error?: string
  }>()
  useEffect(() => {
    if (!active || !uri || !candidate) {
      setSnapshot(undefined)
      return
    }
    let version = 0
    const refresh = async (flushEditor: boolean) => {
      const current = ++version
      try {
        const text = await readRubric(uri, flushEditor)
        const digest = await sha256Text(text)
        if (version === current) setSnapshot({ uri, candidate, text, digest })
      } catch (e) {
        if (version === current)
          setSnapshot({
            uri,
            candidate,
            error: e instanceof Error ? e.message : 'Instructions unavailable',
          })
      }
    }
    const unsubscribe = appState.localNotebooks?.subscribeSync(
      uri,
      () => void refresh(false)
    )
    void refresh(true)
    return () => {
      version++
      unsubscribe?.()
    }
  }, [uri, candidate, active])
  return active && snapshot?.uri === uri && snapshot.candidate === candidate
    ? snapshot
    : undefined
}
