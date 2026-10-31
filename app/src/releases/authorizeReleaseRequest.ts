import type { Control } from './control'

/** The lifetime owner lock prevents concurrent stores; this read-only fence
 * rejects obsolete epochs and prepared legacy participants before effects.
 * Tab IDs identify clients, but no persistent tab registration is required.
 */
export function authorizeReleaseRequest(
  state: Control,
  identity: { releaseId: string; epoch: number },
  request: { tabId?: string; epoch?: number }
): void {
  if (
    !request.tabId ||
    request.epoch !== identity.epoch ||
    state.active?.epoch !== identity.epoch ||
    state.active.manifest.releaseId !== identity.releaseId ||
    state.transition?.phase === 'handoff' ||
    state.transition?.participants[request.tabId]?.ready
  )
    throw new Error(
      'Stale or frozen release: storage request rejected before effects'
    )
}
