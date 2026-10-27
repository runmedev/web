import { ReleaseRecoveryControls } from './ReleaseRecoveryControls'
import { Button } from '@radix-ui/themes'
import { useCallback, useEffect, useState } from 'react'

import { appLogger } from '../lib/logging/runtime'
import {
  type Control,
  type Manifest,
  type ReleaseProgress,
} from '../releases/control'
import '../releases/runtime'
import type { OfflineDownloadStatus } from '../releases/runtime'

/** The launcher remains the authority for downloads and coordinated activation.
 * This view only issues commands and observes state; it never changes the active
 * release or accesses notebook storage itself. Older installed loaders retain
 * the common commands and can use the independent recovery page for rollback.
 */
export function ReleaseControls() {
  return (
    <>
      <ReleaseRecoveryControls />
      <InstalledReleaseControls />
    </>
  )
}

/** Installed-state controls may load independently of recovery controls. */
function InstalledReleaseControls() {
  const api = window.runmeVersions
  const [state, setState] = useState<Control>()
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<ReleaseProgress>()
  const [offline, setOffline] = useState<OfflineDownloadStatus>()
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cached, setCached] = useState<Manifest[]>([])

  // Polling also observes other tabs and older loaders without change events.
  // Ignore late responses after unmount so a closed workspace tab stays closed.
  useEffect(() => {
    if (!api) return
    let disposed = false
    let reading = false
    const refresh = async () => {
      if (reading) return
      reading = true
      try {
        const next = await api.get()
        if (!disposed) {
          setState(next)
          setReadError('')
          setProgress(api.progress?.())
          setOffline(
            next.active && api.offline?.(next.active.manifest.releaseId)
          )
          setMessage(
            api.status?.() ??
              document.querySelector('#runme-release-panel [role="status"]')
                ?.textContent ??
              ''
          )
        }
      } catch (e) {
        if (!disposed) setReadError(String(e))
      } finally {
        reading = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    window.addEventListener('runme-release-change', refresh)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('runme-release-change', refresh)
    }
  }, [api])

  useEffect(() => {
    let disposed = false
    if (api?.cached)
      void api
        .cached()
        .then((value) => {
          if (!disposed) setCached(value)
        })
        .catch((e) => {
          if (!disposed) setError(String(e))
        })
    return () => {
      disposed = true
    }
  }, [api, state?.active?.manifest.releaseId, state?.candidate?.releaseId])

  /** Errors stay in the information tab; downloading never implies activation. */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      setError('')
      try {
        await action()
        if (api) setState(await api.get())
        if (api?.cached) setCached(await api.cached())
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        appLogger.warn('Release management action failed', {
          attrs: { scope: 'release.controls', error: String(e) },
        })
      } finally {
        setBusy(false)
      }
    },
    [api]
  )

  if (!api) return <p>Release channels are available in published builds.</p>
  if (!state)
    return (
      <p role="status">
        {readError || error || 'Loading release information…'}
      </p>
    )
  const active = state.active?.manifest
  const candidate = state.candidate
  const hasUpdate = candidate && candidate.releaseId !== active?.releaseId
  const selection =
    state.selection.kind === 'channel' ? state.selection.name : 'Pinned release'

  return (
    <section
      aria-label="Application versions"
      className="space-y-4 rounded-lg border border-nb-border bg-white p-4"
    >
      <h2 className="text-base font-semibold">Application versions</h2>
      <dl className="grid grid-cols-[120px_1fr] gap-2">
        <dt>Current channel</dt>
        <dd>{selection}</dd>
        <dt>Installed release</dt>
        <dd className="break-all font-mono text-xs">
          {active?.releaseId ?? 'Not installed'}
        </dd>
        {state.selection.kind === 'pinned' && (
          <>
            <dt>Selected release</dt>
            <dd className="break-all font-mono text-xs">
              {state.selection.releaseId}
            </dd>
          </>
        )}
        {candidate && (
          <>
            <dt>Available release</dt>
            <dd className="break-all font-mono text-xs">
              {candidate.releaseId}
            </dd>
          </>
        )}
      </dl>
      <p className="text-nb-text-muted">
        Choose a channel to download its release in the background. Your
        installed version stays active until you choose Upgrade all tabs.
      </p>
      <div id="release-channel-actions" className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !!state.transition}
          onClick={() =>
            void run(() => api.check({ kind: 'channel', name: 'stable' }))
          }
        >
          Follow stable
        </Button>
        <Button
          disabled={busy || !!state.transition}
          onClick={() =>
            void run(() => api.check({ kind: 'channel', name: 'latest' }))
          }
        >
          Follow latest
        </Button>
        <Button
          disabled={busy || !!state.transition}
          onClick={() => void run(() => api.check())}
        >
          Check for updates
        </Button>
        {active && (
          <Button
            disabled={busy || !!state.transition}
            onClick={() =>
              void run(() =>
                api.pin
                  ? api.pin()
                  : api.check({ kind: 'pinned', releaseId: active.releaseId })
              )
            }
          >
            Pin installed release
          </Button>
        )}
      </div>
      {hasUpdate && (
        <Button
          disabled={busy || !!state.transition}
          onClick={() => void run(() => api.upgrade())}
        >
          Upgrade all tabs
        </Button>
      )}
      {state.transition && (
        <div id="release-transition-actions" className="space-y-2">
          <p>
            Upgrade {state.transition.phase}. Each tab must preserve its edits
            before the upgrade can finish.
          </p>
          {state.transition.phase === 'prepare' && (
            <Button
              disabled={busy}
              onClick={() => void run(() => api.cancel())}
            >
              Cancel upgrade
            </Button>
          )}
          <Button disabled={busy} onClick={() => void run(() => api.retry())}>
            Retry preparation / resume
          </Button>
        </div>
      )}
      {(readError || error) && (
        <p role="alert" className="text-red-700">
          {readError || error}
        </p>
      )}
      <p role="status" className="break-words text-nb-text-muted">
        {busy ? 'Working… ' : ''}
        {message}
      </p>
      {progress && (
        <progress
          id="version-download-progress"
          aria-label="Release files verified"
          value={progress.completed}
          max={progress.total}
          className="h-3 w-full accent-violet-600"
        />
      )}
      {offline && (
        <div
          id="version-offline-readiness"
          className="space-y-2 text-nb-text-muted"
        >
          <p className="font-medium">Installed release offline readiness</p>
          <p>
            {offline.phase === 'ready'
              ? 'All release files are verified and cached for offline use.'
              : offline.phase === 'error'
                ? 'The app is ready. Some fonts are not yet available offline.'
                : `The app is ready. Preparing fonts for offline use: ${offline.completed} / ${offline.total} files.`}
          </p>
          {offline.phase === 'downloading' && (
            <progress
              aria-label="Fonts cached for offline use"
              value={offline.total ? offline.completed : undefined}
              max={offline.total || 1}
              className="h-3 w-full accent-violet-600"
            />
          )}
          {offline.phase === 'error' && api.retryOffline && (
            <Button
              disabled={busy || !!state.transition}
              onClick={() => void run(api.retryOffline!)}
            >
              Retry offline font download
            </Button>
          )}
        </div>
      )}
      <details>
        <summary className="cursor-pointer font-semibold">
          Other releases and recovery
        </summary>
        <div
          id="release-other-actions"
          className="mt-3 flex flex-col items-start gap-3"
        >
          {api.activate &&
            cached
              .filter((m) => m.releaseId !== active?.releaseId)
              .map((m) => (
                <Button
                  key={m.releaseId}
                  disabled={busy || !!state.transition}
                  onClick={() => void run(() => api.activate!(m.releaseId))}
                >
                  Use cached {m.webCommit.slice(0, 8)} / {m.buildId.slice(0, 8)}
                </Button>
              ))}
          <Button
            disabled={busy || !!state.transition}
            onClick={() => void run(() => api.prune())}
          >
            Remove unused downloads
          </Button>
        </div>
      </details>
    </section>
  )
}
