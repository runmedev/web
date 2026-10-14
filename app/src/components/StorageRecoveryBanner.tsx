import { useEffect, useState, useSyncExternalStore } from 'react'
import { storageRecovery } from '../storage/storageRecovery'
import {
  readRecoveryDrafts,
  type RecoveryDraft,
} from '../lib/storageRecoveryDrafts'

/** Download a standalone editor copy for explicit recovery, never replay it over the operation log. */
function downloadDraft(draft: RecoveryDraft) {
  const url = URL.createObjectURL(
    new Blob([draft.content], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download =
    draft.name.replace(/\.(runme|json|ipynb)$/i, '') + '-recovery.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Both UI locations subscribe to the same durable-in-page failure signal, even before mount. */
export default function StorageRecoveryBanner({
  location,
}: {
  location: string
}) {
  const state = useSyncExternalStore(
    storageRecovery.subscribe,
    storageRecovery.getSnapshot,
    storageRecovery.getSnapshot
  )
  const [drafts, setDrafts] = useState<RecoveryDraft[]>([])
  useEffect(() => {
    try {
      setDrafts(readRecoveryDrafts())
    } catch {
      /* Saving recovery copies will fail closed. */
    }
  }, [state])
  const busy = state.phase === 'preparing' || state.phase === 'restarting'
  if (state.phase === 'healthy' && !drafts.length) return null
  return (
    <div
      id={`storage-recovery-${location}`}
      role="alert"
      className="mb-2 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-slate-900"
    >
      {state.phase !== 'healthy' && (
        <>
          <p className="font-semibold">Runme storage needs to reconnect</p>
          <p>{state.message}</p>
          <p>
            Restart keeps your tabs open and reloads connected Runme tabs after
            preserving their editor contents.
          </p>
          <button
            type="button"
            className="mt-2 rounded border px-3 py-1 font-semibold disabled:opacity-50"
            disabled={busy}
            onClick={() => storageRecovery.restart()}
          >
            {busy ? 'Preparing restart…' : 'Restart Runme'}
          </button>
        </>
      )}
      {drafts.length > 0 && (
        <div id={`storage-recovery-copies-${location}`} className="mt-2">
          <p>
            Recovery copies of your open notebook editors remain in this tab. If
            edits are missing after restart, download and import the copies as
            separate notebooks.
          </p>
          {drafts.map((draft, index) => (
            <button
              type="button"
              className="mr-2 mt-1 underline"
              key={`${draft.uri}-${index}`}
              onClick={() => downloadDraft(draft)}
            >
              Download {draft.name} recovery copy {index + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
