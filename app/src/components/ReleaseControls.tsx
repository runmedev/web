import { Button } from '@radix-ui/themes'
import { useCallback, useEffect, useState } from 'react'

import { appLogger } from '../lib/logging/runtime'
import {
  type Control,
  type Manifest,
  releaseIdValid,
} from '../releases/control'
import '../releases/runtime'

/** The launcher remains the authority for downloads and coordinated activation.
 * This view only issues commands and observes state; it never changes the active
 * release or accesses notebook storage itself. Older installed loaders retain
 * the common commands and can use the independent recovery page for rollback.
 */
export function ReleaseControls() {
  const api = window.runmeVersions
  const [state, setState] = useState<Control>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [exact, setExact] = useState('')
  const [cached, setCached] = useState<Manifest[]>([])
  const [published, setPublished] = useState<string[]>([])

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
          setMessage(
            api.status?.() ??
              document.querySelector('#runme-release-panel [role="status"]')
                ?.textContent ??
              ''
          )
        }
      } catch (e) {
        if (!disposed) setError(String(e))
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
    return <p role="status">{error || 'Loading release information…'}</p>
  const active = state.active?.manifest
  const candidate = state.candidate
  const hasUpdate = candidate && candidate.releaseId !== active?.releaseId
  const selection =
    state.selection.kind === 'channel' ? state.selection.name : 'Pinned release'
  const recoveryUrl = '/recovery.html' + location.search + location.hash

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
            <dt>Downloaded release</dt>
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
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <p role="status" className="break-words text-nb-text-muted">
        {busy ? 'Working… ' : ''}
        {message}
      </p>
      <details>
        <summary className="cursor-pointer font-semibold">
          Other releases and recovery
        </summary>
        <div
          id="release-other-actions"
          className="mt-3 flex flex-col items-start gap-3"
        >
          <label className="w-full">
            Exact release ID
            <input
              className="mt-1 w-full rounded border border-nb-border p-2 font-mono text-xs"
              value={exact}
              onChange={(e) => setExact(e.target.value)}
              placeholder="<commit>-<build ID>"
            />
          </label>
          <Button
            disabled={
              busy || !!state.transition || !releaseIdValid(exact.trim())
            }
            onClick={() =>
              void run(() =>
                api.check({ kind: 'pinned', releaseId: exact.trim() })
              )
            }
          >
            Download exact release
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const response = await fetch('/releases/catalog.json', {
                  cache: 'no-store',
                  credentials: 'omit',
                  redirect: 'error',
                })
                if (!response.ok)
                  throw new Error(
                    'Published releases are unavailable. Cached releases remain available below.'
                  )
                const catalog = await response.json()
                if (catalog.format !== 1 || !Array.isArray(catalog.releases))
                  throw new Error('Unsupported release catalog')
                setPublished(
                  catalog.releases
                    .slice(-100)
                    .reverse()
                    .map(
                      (release: { releaseId?: unknown }) => release?.releaseId
                    )
                    .filter(releaseIdValid)
                )
              })
            }
          >
            Browse published releases
          </Button>
          {published.map((id) => (
            <Button
              key={id}
              disabled={busy || !!state.transition}
              onClick={() =>
                void run(() => api.check({ kind: 'pinned', releaseId: id }))
              }
            >
              Download {id.slice(0, 8)} / {id.slice(41, 49)}
            </Button>
          ))}
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
          <a
            className="text-blue-600 underline"
            href={recoveryUrl}
            target="_blank"
            rel="noopener"
          >
            Open recovery in another tab
          </a>
        </div>
      </details>
    </section>
  )
}
