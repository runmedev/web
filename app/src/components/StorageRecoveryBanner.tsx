import { appLogger } from '../lib/logging/runtime'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { storageRecovery } from '../storage/storageRecovery'
import {
  captureNotebookRecoveryDrafts,
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
  const [currentDrafts, setCurrentDrafts] = useState<RecoveryDraft[]>([])
  const [captureMessage, setCaptureMessage] = useState('')
  const [diagnostics, setDiagnostics] = useState('')
  const [diagnosing, setDiagnosing] = useState(false)
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
            Storage restart keeps this page and its editors open. Pending editor
            saves remain in this tab and retry after reconnecting. Keep this tab
            open until saves finish, or download recovery copies before closing
            it.
          </p>
          <button
            type="button"
            className="mr-2 mt-2 rounded border px-3 py-1 font-semibold"
            onClick={() => {
              try {
                const copies = captureNotebookRecoveryDrafts()
                setCurrentDrafts(copies)
                setCaptureMessage(
                  copies.length
                    ? 'Current editor snapshots are ready to download below. Capture again after further edits; keep this tab open until downloads are saved.'
                    : 'No loaded editable notebooks are open in this tab.'
                )
              } catch (error) {
                setCaptureMessage(
                  `Could not capture editor copies: ${String(error)}. Keep this tab open.`
                )
              }
            }}
          >
            Get recovery copies
          </button>
          <button
            type="button"
            className="mt-2 rounded border px-3 py-1 font-semibold disabled:opacity-50"
            disabled={busy}
            onClick={() => storageRecovery.restart()}
          >
            {busy ? 'Restarting storage…' : 'Restart storage'}
          </button>
          <button
            type="button"
            className="ml-2 mt-2 rounded border px-3 py-1"
            onClick={() => storageRecovery.restart(true)}
          >
            Force restart storage
          </button>
          <p>
            Force restart skips draining pending work. Editor saves can retry;
            other operations may have an uncertain outcome.
          </p>
        </>
      )}
      {state.phase !== 'healthy' && (
        <div id={`storage-diagnostics-${location}`}>
          <button
            type="button"
            disabled={diagnosing}
            className="mt-2 underline"
            onClick={async () => {
              setDiagnosing(true)
              try {
                const snapshot = await storageRecovery.diagnose()
                setDiagnostics(JSON.stringify(snapshot, null, 2))
                appLogger.info('Storage worker diagnostic snapshot', {
                  attrs: { scope: 'storage.owner', diagnostics: snapshot },
                })
              } catch (error) {
                setDiagnostics(String(error))
              } finally {
                setDiagnosing(false)
              }
            }}
          >
            {diagnosing ? 'Checking worker…' : 'Check storage worker'}
          </button>
          {diagnostics && (
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap"
              aria-label="Storage worker diagnostics"
            >
              {diagnostics}
            </pre>
          )}
          <p>
            Diagnostics do not save or retry notebook operations. A reply
            confirms the worker can process diagnostic messages, not that
            storage writes are working.
          </p>
          {state.phase === 'blocked' && (
            <p>
              If restart cannot finish, download current editor copies in every
              Runme tab first. Then close all Runme tabs for this site and
              reopen Runme. If the worker remains stuck, restart the browser
              after saving the downloads. Do not clear site data.
            </p>
          )}
        </div>
      )}
      {captureMessage && <p>{captureMessage}</p>}
      {currentDrafts.map((draft, index) => (
        <button
          type="button"
          className="mr-2 mt-1 underline"
          key={`current-${draft.uri}-${index}`}
          onClick={() => downloadDraft(draft)}
        >
          Download {draft.name} current editor copy
        </button>
      ))}
      {drafts.length > 0 && (
        <div id={`storage-recovery-copies-${location}`} className="mt-2">
          <p>
            Earlier recovery snapshots remain in this tab’s session storage.
            They do not survive closing this tab. If edits are missing after
            restart, download and import the copies as separate notebooks.
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
