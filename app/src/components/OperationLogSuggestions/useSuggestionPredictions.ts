import { useEffect, useMemo, useRef, useState } from 'react'

import {
  getGraderSettings,
  gradeSuggestion,
  subscribeGraderSettings,
} from '../../lib/suggestionGrader'
import { prepareSuggestionInput } from '../../lib/suggestionGraderInput'
import { classifierPrompt } from '../../lib/trainingExamples/encoding'
import type { ReviewPreview } from './ReviewRevisionPicker'

export type PredictionState =
  | { status: 'none' | 'loading' | 'error'; text: string }
  | { status: 'ready'; accepted: boolean; text: string }

/** Per-view ephemeral cache: exact input/config matches only. Two requests at a time;
 * hiding the tab or changing revisions cancels old work, never displaying stale results.
 * Failed calls remain an abstention until the comparison/config changes (no POST retry loop).
 */
export function useSuggestionPredictions(
  preview: ReviewPreview | undefined,
  active: boolean
) {
  const [generation, setGeneration] = useState(0)
  const [states, setStates] = useState<Record<string, PredictionState>>({})
  const cache = useRef(new Map<string, PredictionState>())
  useEffect(
    () =>
      subscribeGraderSettings(() => {
        cache.current.clear()
        setGeneration((n) => n + 1)
      }),
    []
  )
  const settings = getGraderSettings()
  const tasks = useMemo(
    () =>
      !active || !settings.enabled || !settings.hasApiKey
        ? []
        : (preview?.diff.cells
            .filter((r) => r.kind !== 'unchanged' || r.moved)
            .map((row) => {
              const id = (row.compareCell ?? row.baseCell)!.refId
              try {
                const input = prepareSuggestionInput(preview, id)
                return {
                  id,
                  input,
                  key: generation + ':' + classifierPrompt(input),
                }
              } catch {
                return { id, key: generation + ':invalid:' + row.id }
              }
            }) ?? []),
    [preview, generation, active, settings.enabled, settings.hasApiKey]
  )
  useEffect(() => {
    if (!active || !settings.enabled || !settings.hasApiKey) return
    const controller = new AbortController()
    setStates(
      Object.fromEntries(
        tasks.flatMap((t) => {
          const cached = cache.current.get(t.key)
          return cached ? [[t.key, cached]] : []
        })
      )
    )
    let cursor = 0
    const publish = (key: string, state: PredictionState) => {
      if (controller.signal.aborted) return
      setStates((old) => ({ ...old, [key]: state }))
    }
    const worker = async () => {
      while (!controller.signal.aborted && cursor < tasks.length) {
        const task = tasks[cursor++]
        const existing = cache.current.get(task.key)
        if (existing) {
          publish(task.key, existing)
          continue
        }
        if (!task.input?.operations.length) {
          publish(task.key, {
            status: 'none',
            text: 'AI: no prediction (no supported content change)',
          })
          continue
        }
        publish(task.key, { status: 'loading', text: 'AI: prediction pending' })
        let state: PredictionState
        try {
          const result = await gradeSuggestion(task.input, controller.signal)
          state = {
            status: 'ready',
            accepted: result.accepted,
            text: `AI predicts ${result.accepted ? 'accept' : 'reject'} (${result.model}). Advisory only; no confidence score.`,
          }
        } catch (error) {
          state = {
            status: 'error',
            text:
              error instanceof Error
                ? error.message
                : 'AI prediction unavailable',
          }
        }
        if (controller.signal.aborted) return
        // Bound retained source-text cache keys in long browsing sessions.
        if (cache.current.size >= 128)
          cache.current.delete(cache.current.keys().next().value!)
        cache.current.set(task.key, state)
        publish(task.key, state)
      }
    }
    void worker()
    void worker()
    return () => controller.abort()
  }, [active, tasks, settings.enabled, settings.hasApiKey])
  const taskKeys = new Map(tasks.map((task) => [task.id, task.key]))
  return new Map(
    (preview?.diff.cells ?? []).map((row) => {
      const id = (row.compareCell ?? row.baseCell)!.refId
      return [
        id,
        !settings.enabled
          ? {
              status: 'none' as const,
              text: 'AI: no prediction — enable a model in AI grader settings',
            }
          : !settings.hasApiKey
            ? {
                status: 'none' as const,
                text: 'AI: no prediction — configure an API key in AI grader settings',
              }
            : (states[taskKeys.get(id) ?? ''] ?? {
                status: 'none' as const,
                text: 'AI: no prediction yet',
              }),
      ] as const
    })
  )
}

/** Bright chosen action, subdued alternative, neutral without a prediction.
 * Color communicates a binary recommendation, not an invented probability.
 */
export function predictionButtonClass(
  prediction: PredictionState | undefined,
  action: 'accept' | 'undo'
) {
  if (prediction?.status !== 'ready') return 'text-nb-accent hover:bg-blue-50'
  if (prediction.accepted === (action === 'accept'))
    return action === 'accept'
      ? 'bg-emerald-700 text-white hover:bg-emerald-800'
      : 'bg-red-700 text-white hover:bg-red-800'
  return 'bg-slate-100 text-slate-500 hover:bg-slate-200'
}
