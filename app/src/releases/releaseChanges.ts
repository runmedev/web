/** A hint to reread selected-release state, never an instruction to activate it.
 * No documents or manifests cross this channel. Missed hints are reconciled on
 * pageshow or explicit version actions; correctness rests on DB admission.
 */
let channel: BroadcastChannel | undefined
function releaseChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined
  try {
    return (channel ??= new BroadcastChannel('runme-release-changed-v1'))
  } catch {
    return undefined
  }
}

/** Notify peers only after a control transaction has committed. */
export function notifyReleaseChange(): void {
  try {
    releaseChannel()?.postMessage('changed')
  } catch {
    // A notification failure must not turn a committed write into an uncertain one.
  }
}

/** Observe other realms without a recurring settings read in every tab. */
export function subscribeReleaseChanges(listener: () => void): () => void {
  const channel = releaseChannel()
  const receive = (event: MessageEvent) => {
    if (event.data === 'changed') listener()
  }
  channel?.addEventListener('message', receive)
  return () => channel?.removeEventListener('message', receive)
}
