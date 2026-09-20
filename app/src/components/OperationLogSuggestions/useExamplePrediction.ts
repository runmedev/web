import { useEffect, useRef, useState } from 'react'

import {
  type GraderPrediction,
  getGraderSettings,
  gradeSuggestion,
  subscribeGraderSettings,
} from '../../lib/suggestionGrader'
import { classifierPrompt } from '../../lib/trainingExamples/encoding'
import type { PreparedExample } from '../../lib/trainingExamples/payloads'

type State =
  | { status: 'none' | 'loading' | 'error'; text: string }
  | { status: 'ready'; prediction: GraderPrediction }

/** Grade exactly the displayed example, never its label or provenance. Keep a
 * bounded per-view cache; cancel hidden/obsolete work and invalidate on settings
 * changes. Errors are cached too, so navigation cannot silently retry a POST.
 */
export function useExamplePrediction(
  input: PreparedExample | undefined,
  active: boolean
): State {
  const [generation, setGeneration] = useState(0)
  const [result, setResult] = useState<{ key: string; state: State }>()
  const cache = useRef(new Map<string, State>())
  useEffect(
    () =>
      subscribeGraderSettings(() => {
        cache.current.clear()
        setGeneration((value) => value + 1)
      }),
    []
  )
  const settings = getGraderSettings()
  const key =
    active && settings.enabled && settings.hasApiKey && input?.operations.length
      ? `${generation}:${classifierPrompt(input)}`
      : ''
  useEffect(() => {
    if (!key || !input) return
    const controller = new AbortController()
    const cached = cache.current.get(key)
    if (cached) {
      setResult({ key, state: cached })
      return
    }
    const publish = (state: State) => {
      if (controller.signal.aborted) return
      if (cache.current.size >= 128)
        cache.current.delete(cache.current.keys().next().value!)
      cache.current.set(key, state)
      setResult({ key, state })
    }
    void gradeSuggestion(input, controller.signal).then(
      (prediction) => publish({ status: 'ready', prediction }),
      (error) =>
        publish({
          status: 'error',
          text:
            error instanceof Error ? error.message : 'Prediction unavailable',
        })
    )
    return () => controller.abort()
  }, [key, input])
  // Gate during render as well as in the effect: an old result must never flash
  // next to a newly selected example or after credentials have changed.
  if (!active)
    return {
      status: 'none',
      text: 'Prediction paused while this view is hidden.',
    }
  if (!settings.enabled)
    return { status: 'none', text: 'Enable predictions in AI grader settings.' }
  if (!settings.hasApiKey)
    return {
      status: 'none',
      text: 'Configure an API key in AI grader settings.',
    }
  if (!input) return { status: 'none', text: 'Waiting for example input…' }
  if (!input.operations.length)
    return { status: 'none', text: 'No prediction: no content changes.' }
  return result?.key === key
    ? result.state
    : { status: 'loading', text: 'Predicting…' }
}
