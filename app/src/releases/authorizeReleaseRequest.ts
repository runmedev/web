/** The host closes admission before draining. The lifetime lock prevents two
 * store owners; the connected worker's identity fences stale client messages.
 * Notebook requests never consult release preferences or persistent tab records.
 */
export function authorizeReleaseRequest(
  identity: { releaseId: string; epoch: number },
  request: { tabId?: string; epoch?: number }
): void {
  if (!request.tabId || request.epoch !== identity.epoch)
    throw new Error('Stale release: storage request rejected before effects')
}
