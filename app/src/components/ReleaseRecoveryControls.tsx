import { useState } from 'react'
import type { Manifest } from '../releases/control'
import {
  publishedReleaseIds,
  resolvePublishedRelease,
} from '../releases/releaseCatalog'
import { releaseDatabaseDiagnostics } from '../releases/releaseDiagnostics'
import '../releases/runtime'

/** Recovery navigation and release discovery never wait for settings reads.
 * Downloading is independent; activation still requires safe storage ownership.
 */
export function ReleaseRecoveryControls() {
  const api = window.runmeVersions
  const [input, setInput] = useState('')
  const [releases, setReleases] = useState<string[]>([])
  const [prepared, setPrepared] = useState<Manifest>()
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [diagnostics, setDiagnostics] = useState('')
  const recoveryUrl = new URL('/recovery.html', window.location.href)
  recoveryUrl.search = window.location.search
  recoveryUrl.hash = window.location.hash
  if (selected) {
    recoveryUrl.searchParams.delete('channel')
    recoveryUrl.searchParams.set('release', selected)
  }
  /** Keep failures local and leave navigation available during pending commands. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      id="release-recovery-controls"
      aria-label="Release recovery"
      className="space-y-2 rounded border p-3"
    >
      <h2 className="font-semibold">Recovery and rollback</h2>
      <p>
        Choose a published commit or release, even when installed release
        settings cannot load. Activation replaces the shared storage worker.
        This tab preserves its edits before reloading; other tabs stay open.
      </p>
      <label>
        Commit SHA or release ID
        <input
          disabled={busy}
          value={input}
          onChange={(event) => {
            setInput(event.target.value)
            setPrepared(undefined)
            setSelected('')
          }}
          className="ml-2 rounded border p-1 font-mono"
          placeholder="Commit SHA or <commit>-<build ID>"
        />
      </label>
      <div id="release-recovery-actions" className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => setReleases(await publishedReleaseIds()))
          }
        >
          Browse published releases
        </button>
        <button
          type="button"
          disabled={busy || !input.trim()}
          onClick={() =>
            void run(async () => {
              const id = await resolvePublishedRelease(input)
              setSelected(id)
              setPrepared(undefined)
              if (!api?.prepareRecovery) {
                setMessage(
                  'This launcher requires the independent recovery page. Open recovery below to use the selected release.'
                )
                return
              }
              const manifest = await api.prepareRecovery({
                kind: 'pinned',
                releaseId: id,
              })
              setPrepared(manifest)
              setMessage(
                'Release downloaded and verified. It has not been activated.'
              )
            })
          }
        >
          Prepare selected release
        </button>
        {prepared && api?.recover && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.recover!({
                  kind: 'pinned',
                  releaseId: prepared.releaseId,
                })
                setMessage(
                  'Worker activation requested. Other tabs keep their editors open.'
                )
              })
            }
          >
            Activate selected release
          </button>
        )}
        <a
          href={recoveryUrl.pathname + recoveryUrl.search + recoveryUrl.hash}
          target="_blank"
          rel="noopener"
        >
          Open recovery in another tab
        </a>
        <button
          type="button"
          onClick={() =>
            setDiagnostics(
              JSON.stringify(
                api?.diagnostics?.() ?? {
                  launcherDiagnostics:
                    'Unavailable in this launcher. The following traces are from the app only.',
                  app: releaseDatabaseDiagnostics(),
                },
                null,
                2
              )
            )
          }
        >
          Show release settings diagnostics
        </button>
      </div>
      {releases.length > 0 && (
        <label>
          Published releases
          <select
            disabled={busy}
            value=""
            onChange={(event) => {
              setInput(event.target.value)
              setSelected(event.target.value)
              setPrepared(undefined)
            }}
          >
            <option value="" disabled>
              Select a build
            </option>
            {releases.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}
      {message && <p role="status">{message}</p>}
      {diagnostics && (
        <pre
          aria-label="Release settings diagnostics"
          className="max-h-64 overflow-auto whitespace-pre-wrap"
        >
          {diagnostics}
        </pre>
      )}
    </section>
  )
}
