import type { Control } from './control'

export type ReleaseAttention = {
  kind: 'update' | 'reload' | 'busy' | 'error'
  message: string
}

/** Describe actionable version state without fetching or activating a release. */
export function releaseAttention(
  state: Control,
  runningReleaseId?: string
): ReleaseAttention | undefined {
  if (state.ownerError)
    return { kind: 'error', message: 'Version activation needs attention' }
  if (state.transition)
    return {
      kind: 'busy',
      message:
        state.transition.phase === 'prepare'
          ? 'An earlier upgrade needs attention'
          : 'Version activation in progress',
    }
  if (
    runningReleaseId &&
    state.active &&
    runningReleaseId !== state.active.manifest.releaseId
  )
    return { kind: 'reload', message: 'This tab is out of date' }
  if (
    state.candidate &&
    state.candidate.releaseId !== state.active?.manifest.releaseId
  )
    return { kind: 'update', message: 'An update is ready to activate' }
  return undefined
}
