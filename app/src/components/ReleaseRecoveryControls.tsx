import { Button, ScrollArea } from '@radix-ui/themes'
import { useEffect, useState } from 'react'
import type { Manifest } from '../releases/control'
import {
  publishedReleaseIds,
  resolvePublishedRelease,
} from '../releases/releaseCatalog'
import { releaseDatabaseDiagnostics } from '../releases/releaseDiagnostics'
import { showWorkspaceDocument } from '../lib/workspaceDocuments/workspaceDocumentController'
import { VERSION_INFO_DOCUMENT_URI } from '../lib/workspaceDocuments/workspaceDocumentTypes'
import '../releases/runtime'

type Step = 'choose' | 'select' | 'review' | 'done'

/** A tab-local wizard separates choosing, downloading and activating a release.
 * Discovery and recovery navigation remain usable even if settings never reply.
 */
export function ReleaseRecoveryControls() {
  const api = window.runmeVersions
  const [step, setStep] = useState<Step>('choose')
  const [source, setSource] = useState<'browse' | 'commit'>('browse')
  const [installed, setInstalled] = useState<string>()
  const [settingsError, setSettingsError] = useState('')
  const [input, setInput] = useState('')
  const [releases, setReleases] = useState<string[]>([])
  const [listed, setListed] = useState(false)
  const [prepared, setPrepared] = useState<Manifest>()
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState('')

  useEffect(() => {
    let disposed = false
    if (api)
      void api
        .get()
        .then((state) => {
          if (!disposed) setInstalled(state.active?.manifest.releaseId)
        })
        .catch(() => {
          if (!disposed)
            setSettingsError(
              'Installed release settings are unavailable. You can still choose another release.'
            )
        })
    return () => {
      disposed = true
    }
  }, [api])

  const recoveryUrl = new URL('/recovery.html', window.location.href)
  recoveryUrl.search = window.location.search
  recoveryUrl.hash = window.location.hash
  if (selected) {
    recoveryUrl.searchParams.delete('channel')
    recoveryUrl.searchParams.set('release', selected)
  }
  /** Keep errors in this tab; navigation stays available during stalled work. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  const back = () => {
    setStep(step === 'review' && selected !== installed ? 'select' : 'choose')
    setError('')
    setMessage('')
    setPrepared(undefined)
  }
  const review = (id: string) => {
    setSelected(id)
    setPrepared(undefined)
    setStep('review')
    setError('')
  }
  const choiceClass =
    'rounded-xl border border-nb-border bg-white p-5 text-left transition hover:border-violet-500 hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600 disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <ScrollArea type="auto" scrollbars="vertical" className="flex-1 p-6">
      <section
        id="pin-release"
        aria-label="Pin Release"
        className="mx-auto max-w-2xl space-y-6 text-sm"
      >
        <div id="pin-release-heading" className="space-y-2">
          <h1 className="text-2xl font-semibold">Pin Release</h1>
          <p className="text-nb-text-muted">
            Choose the version Runme should stay on. You can follow a channel
            again at any time.
          </p>
        </div>
        <ol
          aria-label="Pin release steps"
          className="flex gap-4 text-xs text-nb-text-muted"
        >
          {['Choose', 'Select release', 'Review', 'Pinned'].map(
            (label, index) => (
              <li
                key={label}
                aria-current={
                  ['choose', 'select', 'review', 'done'][index] === step
                    ? 'step'
                    : undefined
                }
                className={
                  ['choose', 'select', 'review', 'done'][index] === step
                    ? 'font-semibold text-violet-700'
                    : ''
                }
              >
                {index + 1}. {label}
              </li>
            )
          )}
        </ol>

        {step === 'choose' && (
          <div id="pin-release-choices" className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className={choiceClass}
              disabled={busy || !installed}
              onClick={() => {
                setSelected(installed!)
                setStep('review')
              }}
            >
              <span className="block text-base font-semibold">
                Keep the installed release
              </span>
              <span className="mt-2 block text-nb-text-muted">
                {installed
                  ? `Stay on commit ${installed.slice(0, 8)}. No download or reload.`
                  : 'Installed release information is unavailable.'}
              </span>
            </button>
            <button
              type="button"
              className={choiceClass}
              onClick={() => setStep('select')}
            >
              <span className="block text-base font-semibold">
                Choose another release
              </span>
              <span className="mt-2 block text-nb-text-muted">
                Browse published builds or enter a commit.
              </span>
            </button>
          </div>
        )}
        {step === 'choose' && settingsError && (
          <p role="status">{settingsError}</p>
        )}

        {step === 'select' && (
          <div id="pin-release-selection" className="space-y-4">
            <div
              id="pin-release-source"
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Find a release"
            >
              <Button
                variant={source === 'browse' ? 'solid' : 'outline'}
                aria-pressed={source === 'browse'}
                disabled={busy}
                onClick={() => {
                  setSource('browse')
                  setError('')
                }}
              >
                Browse releases
              </Button>
              <Button
                variant={source === 'commit' ? 'solid' : 'outline'}
                aria-pressed={source === 'commit'}
                disabled={busy}
                onClick={() => {
                  setSource('commit')
                  setError('')
                }}
              >
                Enter a commit
              </Button>
            </div>
            {source === 'browse' ? (
              <>
                <p className="text-nb-text-muted">
                  Choose a published build. Each commit can have more than one
                  build.
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setReleases(await publishedReleaseIds())
                      setListed(true)
                    })
                  }
                >
                  {listed ? 'Refresh releases' : 'Load published releases'}
                </Button>
                {listed && !releases.length && (
                  <p>
                    No published releases found. You can enter a full release ID
                    instead.
                  </p>
                )}
                <div
                  id="pin-release-list"
                  className="max-h-80 space-y-2 overflow-y-auto"
                >
                  {releases.map((id) => (
                    <button
                      type="button"
                      key={id}
                      disabled={busy}
                      className={`${choiceClass} block w-full`}
                      onClick={() => review(id)}
                    >
                      <span className="block font-medium">
                        Commit {id.slice(0, 8)}
                      </span>
                      <span className="block font-mono text-xs text-nb-text-muted">
                        Build {id.split('-')[1].slice(0, 12)}
                        {id === installed ? ' · Installed' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <label className="block space-y-2">
                  <span className="font-medium">Commit SHA or release ID</span>
                  <input
                    disabled={busy}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="e.g. eb786ba"
                    className="block w-full rounded-md border border-nb-border bg-white px-3 py-2 font-mono focus:outline-violet-600"
                  />
                </label>
                <p className="text-nb-text-muted">
                  Use at least 7 characters of a published commit, or a full
                  release ID.
                </p>
                <Button
                  disabled={busy || !input.trim()}
                  onClick={() =>
                    void run(async () =>
                      review(await resolvePublishedRelease(input))
                    )
                  }
                >
                  Review release
                </Button>
              </>
            )}
          </div>
        )}

        {(step === 'review' || step === 'done') && (
          <div
            id="pin-release-review"
            className="space-y-4 rounded-xl border border-nb-border bg-white p-5"
          >
            <h2 className="text-lg font-semibold">
              {step === 'done'
                ? 'Release pinned'
                : selected === installed
                  ? 'Keep this version?'
                  : 'Pin this release?'}
            </h2>
            <dl className="grid grid-cols-[80px_1fr] gap-2">
              <dt>Commit</dt>
              <dd className="break-all font-mono text-xs">
                {selected.split('-')[0]}
              </dd>
              <dt>Build</dt>
              <dd className="break-all font-mono text-xs">
                {selected.split('-')[1]}
              </dd>
            </dl>
            <p className="text-nb-text-muted">
              {selected === installed
                ? 'Runme will stop following channel updates. Your running app stays unchanged.'
                : 'Pinning downloads this build. Your running app stays unchanged until you activate it.'}
            </p>
            {step === 'review' && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!api)
                      throw new Error(
                        'This launcher requires the recovery page. Open recovery under Troubleshooting.'
                      )
                    if (selected === installed && api.pin) {
                      const current = await api.get()
                      if (current.active?.manifest.releaseId !== selected)
                        throw new Error(
                          'The installed release changed. Reopen Pin Release to review the current version.'
                        )
                      await api.pin()
                    } else {
                      // Cache first, independently of the settings DB. If recording the
                      // pin fails, the verified download remains available for recovery.
                      if (api.prepareRecovery)
                        setPrepared(
                          await api.prepareRecovery({
                            kind: 'pinned',
                            releaseId: selected,
                          })
                        )
                      await api.check({ kind: 'pinned', releaseId: selected })
                    }
                    setStep('done')
                    setMessage(
                      'Pinned. Channel updates will stay paused until you choose Follow stable or Follow latest.'
                    )
                  })
                }
              >
                {selected === installed
                  ? 'Pin installed release'
                  : 'Pin and download'}
              </Button>
            )}
            {prepared && error && (
              <p className="text-nb-text-muted">
                The release was downloaded, but pinning did not finish. Retry or
                use recovery below.
              </p>
            )}
            {((step === 'done' && selected !== installed) ||
              (prepared && error)) &&
              api?.recover && (
                <>
                  <p className="text-nb-text-muted">
                    Activating saves and reloads this tab. Other tabs stay open.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.recover!({
                          kind: 'pinned',
                          releaseId: selected,
                        })
                        setMessage('Activation requested.')
                      })
                    }
                  >
                    {step === 'done'
                      ? 'Activate release and update this tab'
                      : 'Recover with this release'}
                  </Button>
                </>
              )}
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800"
          >
            {error}
          </p>
        )}
        {(busy || message) && (
          <p role="status" className="text-nb-text-muted">
            {busy ? 'Working…' : message}
          </p>
        )}
        <div id="pin-release-navigation" className="flex gap-3">
          {step !== 'choose' && step !== 'done' && (
            <Button variant="outline" disabled={busy} onClick={back}>
              Back
            </Button>
          )}
          {step === 'done' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setStep('choose')
                setPrepared(undefined)
                setMessage('')
                setError('')
              }}
            >
              Pin a different release
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => showWorkspaceDocument(VERSION_INFO_DOCUMENT_URI)}
          >
            Back to version information
          </Button>
        </div>
        <details className="border-t border-nb-border pt-4">
          <summary className="cursor-pointer font-medium text-nb-text-muted">
            Troubleshooting
          </summary>
          <div id="pin-release-troubleshooting" className="mt-4 space-y-3">
            <p className="text-nb-text-muted">
              If this tab cannot finish, use the independent recovery page.
            </p>
            <Button asChild variant="outline">
              <a
                href={
                  recoveryUrl.pathname + recoveryUrl.search + recoveryUrl.hash
                }
                target="_blank"
                rel="noopener"
              >
                Open recovery in another tab ↗
              </a>
            </Button>
            <div id="pin-release-diagnostics-action">
              <Button
                variant="outline"
                onClick={() =>
                  setDiagnostics(
                    JSON.stringify(
                      api?.diagnostics?.() ?? {
                        app: releaseDatabaseDiagnostics(),
                      },
                      null,
                      2
                    )
                  )
                }
              >
                Show release settings diagnostics
              </Button>
            </div>
            {diagnostics && (
              <pre
                aria-label="Release settings diagnostics"
                className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-nb-surface-2 p-3 text-xs"
              >
                {diagnostics}
              </pre>
            )}
          </div>
        </details>
      </section>
    </ScrollArea>
  )
}
