import {
  type Active,
  type Manifest,
  OWNER_LOCK,
  type ReleaseProgress,
  type Selection,
  control,
  discover,
  pruneUnusedCaches,
  readControl,
  releaseIdValid,
  releasePrefix,
  stage,
  startupMarker,
  validateManifest,
  validateSelection,
  verifyCache,
} from './control'
import { loaderController } from './loaderController'
import { recoverUnreadableControl } from './recoverControl'
import { ReleaseControlError } from './releaseDatabase'
import type { OfflineDownloadStatus, ReleaseRuntime } from './runtime'
import { startupDiagnostics } from './startupDiagnostics'
import { prepareStartupRecovery } from './startupRecovery'

const tabId = crypto.randomUUID()
const panel = document.createElement('section')
panel.id = 'runme-release-panel'
panel.setAttribute('aria-label', 'Runme versions')
panel.style.cssText =
  'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:white;color:#222;border:1px solid #aaa;border-radius:8px;padding:12px;max-width:480px;font:14px system-ui;max-height:80vh;overflow:auto'
const status = document.createElement('p')
status.setAttribute('role', 'status')
panel.append(status)
const progressBar = document.createElement('progress')
progressBar.id = 'runme-release-progress'
progressBar.setAttribute('aria-label', 'Release files verified')
progressBar.style.cssText = 'width:100%;height:12px;accent-color:#5a3ae0'
progressBar.hidden = true
panel.append(progressBar)
const diagnostics = startupDiagnostics()
panel.append(diagnostics.element)
let progress: ReleaseProgress | undefined
document.body.append(panel)
let runtime: ReleaseRuntime | undefined
let preparation: string | undefined
let prepared = false
let uiKey = ''
let renderGeneration = 0
let preparing = false
let ticking = false
let owner: SharedWorker | undefined
let ownerKey = ''
let dismissedCandidate: string | undefined
let appReady = false
let versionUiUsers = 0
let transitioning = false
let details = location.pathname === '/recovery.html'
const recovery = details
let startupPrepared = false
let recoveringStartup = false
let deferredFonts = false
const startupScope = (): 'startup' | 'all' =>
  deferredFonts ? 'startup' : 'all'
const offlineDownloads = new Map<string, OfflineDownloadStatus>()
const fontJobs = new Map<string, Promise<void>>()

/** Finish optional fonts after the UI is usable. This uses separate progress so
 * background failures cannot overwrite foreground upgrade or recovery messages.
 * The shared cache lock prevents pruning while a background job is writing.
 */
function completeOffline(manifest: Manifest): Promise<void> {
  const id = manifest.releaseId
  const existing = fontJobs.get(id)
  if (existing) return existing
  const update = (value: OfflineDownloadStatus) => {
    offlineDownloads.set(id, value)
    window.dispatchEvent(new Event('runme-release-change'))
  }
  update({ phase: 'downloading', completed: 0, total: 0 })
  const job = navigator.locks
    .request('runme-release-cache', { mode: 'shared' }, async () => {
      await stage(
        manifest,
        (value) => update({ ...value, phase: 'downloading' }),
        'fonts'
      )
      update({ ...offlineDownloads.get(id)!, phase: 'ready' })
    })
    .catch((error) => {
      update({
        ...offlineDownloads.get(id)!,
        phase: 'error',
        message: String(error),
      })
    })
    .finally(() => fontJobs.delete(id))
  fontJobs.set(id, job)
  return job
}

/** Display diagnostics as text, never executable release metadata or user content. */
function report(value: unknown, nextProgress?: ReleaseProgress): void {
  status.textContent = String(value instanceof Error ? value.message : value)
  progress = nextProgress
  progressBar.hidden = !progress
  if (progress) {
    progressBar.max = progress.total
    progressBar.value = progress.completed
  }
  window.dispatchEvent(new Event('runme-release-change'))
}

/** The bar measures verified files, including reusable cached files, not bytes
 * transferred. A completed download is distinct from starting the application.
 */
function reportProgress(label: string, value: ReleaseProgress): void {
  const percent = Math.floor((value.completed / value.total) * 100)
  report(
    `${label}: ${value.completed} / ${value.total} files (${percent}%)`,
    value
  )
}
function button(label: string, action: () => unknown): void {
  const b = document.createElement('button')
  b.textContent = label
  b.style.cssText = 'margin:4px;padding:5px'
  b.onclick = () => {
    Promise.resolve().then(action).catch(report)
  }
  panel.append(b)
}
function freeze(): void {
  const root = document.getElementById('root')
  if (root) root.inert = true
}

/** App readiness does not imply version controls exist: a newer launcher can
 * host an older app. Hide fallback controls only after an explicit UI handoff.
 */
function updatePanelVisibility(): void {
  panel.hidden = appReady && versionUiUsers > 0 && !recovery && !transitioning
}

/** A held tab lock is proof of liveness, including suspended tabs. No heartbeat
 * timeout removes participants. Release only on document destruction, not blur.
 */
async function holdTab(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(`runme-release-tab-${tabId}`, () => {
        resolve()
        return new Promise<void>(() => {})
      })
      .catch(reject)
  })
}
async function closed(id: string): Promise<boolean> {
  return navigator.locks.request(
    `runme-release-tab-${id}`,
    { ifAvailable: true },
    (lock) => Boolean(lock)
  )
}

/** The old service worker must finish its normal lifecycle before the new loader
 * can open storage. The root worker becomes a non-writing retirement sentinel.
 * An existing pre-contract owner answers no sentinel handshake, so fail closed.
 */
async function installLoader(): Promise<void> {
  report('Connecting to the installed loader…')
  diagnostics.record('controller-state', 'info', {
    controlled: Boolean(navigator.serviceWorker.controller),
    workerState: navigator.serviceWorker.controller?.state ?? 'none',
  })
  const controller = await diagnostics.step('loader-connection', () =>
    loaderController(navigator.serviceWorker)
  )
  report('Checking loader compatibility with other tabs…')
  const channel = new MessageChannel()
  await diagnostics.step(
    'loader-compatibility',
    () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                'Close all Runme tabs, then reopen Runme to finish installing the controlled loader. Preserve unsaved edits first.'
              )
            ),
          10000
        )
        channel.port1.onmessage = (e) => {
          clearTimeout(timer)
          channel.port1.close()
          if (e.data === 'runme-loader-1') resolve()
          else
            reject(
              new Error(String(e.data || 'Unsupported loader service worker'))
            )
        }
        controller.postMessage('runme-loader-version', [channel.port2])
      })
  )
  // Older protocol-1 workers do not recognize startup markers. Keep their eager
  // policy until the controlling worker can verify on-demand font responses.
  const capability = new MessageChannel()
  deferredFonts = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      capability.port1.close()
      resolve(false)
    }, 1000)
    capability.port1.onmessage = (event) => {
      clearTimeout(timer)
      capability.port1.close()
      resolve(event.data === 'deferred-fonts-v1')
    }
    controller.postMessage('runme-loader-font-policy', [capability.port2])
  })
  report('Checking storage compatibility…')
  const legacy = new SharedWorker('/storage-owner.js', {
    type: 'module',
    name: 'runme-storage-owner',
  })
  try {
    await diagnostics.step(
      'legacy-storage-check',
      () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  'An older storage owner is still running. Save or download recovery copies in every old tab, close all Runme tabs, then reopen.'
                )
              ),
            3000
          )
          legacy.port.onmessage = (e) => {
            if (e.data === 'runme-legacy-owner-retired') {
              clearTimeout(timer)
              resolve()
            }
          }
          legacy.port.start()
          legacy.port.postMessage('retired?')
        })
    )
  } finally {
    legacy.port.close()
  }
}

/** Discovery stages only. Changing a selection or refreshing never activates it. */
async function check(selection?: Selection): Promise<void> {
  await navigator.locks.request('runme-release-cache', { mode: 'shared' }, () =>
    downloadSelection(selection)
  )
}
async function downloadSelection(selection?: Selection): Promise<void> {
  if (selection)
    await control((s) => {
      s.selection = validateSelection(selection)
      delete s.candidate
    })
  const selected = (await readControl()).selection
  report('Checking and downloading the selected release…')
  const candidate = await discover(selected)
  await stage(
    candidate,
    (value) => reportProgress('Downloading and verifying startup files', value),
    startupScope()
  )
  await control((s) => {
    if (JSON.stringify(s.selection) === JSON.stringify(selected))
      s.candidate = candidate
  })
  await render()
  if (appReady) void completeOffline(candidate)
}

async function begin(target: Manifest): Promise<void> {
  await navigator.locks.request('runme-release-cache', { mode: 'shared' }, () =>
    beginLocked(target)
  )
}
async function beginLocked(target: Manifest): Promise<void> {
  report('Verifying the downloaded release…')
  await verifyCache(
    target,
    (value) => reportProgress('Verifying downloaded release', value),
    startupScope()
  )
  const current = await readControl()
  if (current.recoveredControlFormat && target.recoveredControlFormat !== 1)
    throw new Error(
      'This release predates release-settings recovery. Choose a newer release.'
    )
  const pending = current.transition
  if (pending?.phase === 'handoff') {
    // Recovery can replace a failed candidate only while no storage owner exists.
    // A frozen/unresponsive owner is never evicted by a timeout.
    await navigator.locks.request(
      OWNER_LOCK,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error(
            'A storage owner is still draining or starting; wait or close its tabs'
          )
        await control((s) => {
          if (s.transition?.id !== pending.id || !s.ownerError)
            throw new Error(
              'Wait for candidate startup or retry the pending upgrade'
            )
          if (
            pending.target.storageCompatibilityId !==
            target.storageCompatibilityId
          )
            throw new Error('Incompatible recovery release')
          if (s.emergencyRestart)
            throw new Error(
              'Finish the pending storage recovery before upgrading'
            )
          s.transition = {
            ...pending,
            id: crypto.randomUUID(),
            target,
            epoch: pending.epoch + 1,
          }
          delete s.ownerError
        })
      }
    )
    ownerKey = ''
    await render()
    return
  }
  await control((s) => {
    if (s.transition)
      throw new Error(
        'An upgrade is already pending. Resume or cancel it below.'
      )
    if (s.active?.manifest.releaseId === target.releaseId) return
    if (
      s.active &&
      s.active.manifest.storageCompatibilityId !== target.storageCompatibilityId
    )
      throw new Error('This release cannot read and write current data')
    if (s.emergencyRestart)
      throw new Error('Finish the pending storage recovery before upgrading')
    s.transition = {
      id: crypto.randomUUID(),
      from: s.active,
      target,
      epoch: Math.max(s.active?.epoch ?? 0, s.epochBase ?? 0) + 1,
      phase: 'prepare',
      participants: Object.fromEntries(
        Object.entries(s.tabs).map(([id, tab]) => [id, { epoch: tab.epoch }])
      ),
    }
  })
  await render()
}

/** Each loop advances one durable phase under a short coordinator lock. Losing
 * this tab loses no decision: another launcher resumes the same transition.
 */
async function coordinate(): Promise<void> {
  await navigator.locks.request(
    'runme-release-transition',
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return
      const state = await readControl()
      const gone: string[] = []
      for (const id of Object.keys(state.tabs))
        if (await closed(id)) gone.push(id)
      const transition = state.transition
      const allReady =
        transition?.phase === 'prepare' &&
        Object.entries(transition.participants).every(
          ([id, p]) => gone.includes(id) || (p.ready !== undefined && !p.error)
        )
      if (allReady)
        await verifyCache(transition.target, undefined, startupScope())
      await control((s) => {
        for (const id of gone) {
          delete s.tabs[id]
          if (s.transition) delete s.transition.participants[id]
        }
        if (
          transition &&
          allReady &&
          s.transition?.id === transition.id &&
          s.transition.phase === 'prepare' &&
          Object.values(s.transition.participants).every(
            (p) => p.ready !== undefined && !p.error
          )
        )
          s.transition.phase = 'handoff'
      })
    }
  )
  const state = await readControl()
  const pending = state.transition
  if (pending?.phase === 'handoff')
    startOwner({ manifest: pending.target, epoch: pending.epoch })
}

/** Starting a worker only contends for the lifetime lock. Its verified startup
 * commits the target; the tab cannot declare an uninitialized owner active.
 */
function startOwner(active: Active): void {
  const key = `${active.manifest.releaseId}-${active.epoch}`
  if (ownerKey === key) return
  owner?.port.close()
  ownerKey = key
  owner = new SharedWorker(
    `${releasePrefix(active.manifest.releaseId)}${active.manifest.owner.entry}`,
    { type: 'module', name: `runme-storage-owner-${key}` }
  )
  owner.port.onmessage = (e) => {
    if (e.data?.type === 'release-owner-error') report(e.data.error)
  }
  owner.onerror = () => {
    const message =
      'Storage startup failed. Retry from Versions or select a cached compatible release; current notebook data has been retained.'
    // A module-load failure happens before the worker can persist diagnostics.
    // Record it here so recovery can replace a failed handoff under OWNER_LOCK.
    // Do not retry endlessly: the user can explicitly resume or choose recovery.
    void control((s) => {
      if (
        s.transition?.phase === 'handoff' &&
        s.transition.target.releaseId === active.manifest.releaseId &&
        s.transition.epoch === active.epoch
      )
        s.ownerError = { transitionId: s.transition.id, message }
    }).catch(report)
    report(message)
  }
  owner.port.start()
}

/** Before handoff, cancellation leaves the current owner active. Prepared tabs
 * reload their confirmed durable state; failed tabs keep their unsaved editors.
 */
async function cancel(expectedId?: string): Promise<void> {
  await control((s) => {
    if (!s.transition) return
    if (expectedId && s.transition.id !== expectedId)
      throw new Error(
        'This upgrade was superseded; review the current transition before canceling'
      )
    if (s.transition.phase !== 'prepare')
      throw new Error(
        'Storage handoff already started; use phase-aware recovery'
      )
    delete s.transition
    delete s.ownerError
  })
  await render()
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const state = await readControl()
    const transition = state.transition
    const nextUiKey = JSON.stringify([
      state.active?.epoch,
      state.candidate?.releaseId,
      transition?.id,
      transition?.phase,
      state.selection,
    ])
    if (uiKey !== nextUiKey) {
      uiKey = nextUiKey
      await render()
    }
    if (prepared && !transition) {
      location.reload()
      return
    }
    if (runtime && state.active?.epoch !== runtime.active.epoch) {
      freeze()
      location.reload()
      return
    }
    if (
      runtime &&
      transition?.phase === 'prepare' &&
      transition?.participants[tabId] &&
      preparation !== transition.id &&
      !preparing
    ) {
      freeze()
      if (!runtime.prepare) {
        report('Waiting for application startup before preserving edits…')
        return
      }
      preparing = true
      try {
        const refs = await runtime.prepare()
        prepared = true
        await control((s) => {
          if (
            s.transition?.id !== transition.id ||
            s.transition.phase !== 'prepare'
          )
            throw new Error('Upgrade preparation changed')
          s.transition.participants[tabId].ready = refs
          delete s.transition.participants[tabId].error
        })
        preparation = transition.id
      } catch (error) {
        await control((s) => {
          if (s.transition?.id === transition.id)
            s.transition.participants[tabId].error = String(error)
        })
        preparation =
          error instanceof Error && error.name === 'UpgradeBusyError'
            ? undefined
            : transition.id
        if (prepared) {
          location.reload()
          return
        }
        const root = document.getElementById('root')
        if (root) root.inert = false
      } finally {
        preparing = false
      }
    }
    await coordinate()
    const latest = await readControl()
    if (!runtime && !recovery && latest.active && !latest.transition)
      await boot(latest.active)
    if (
      latest.ownerError &&
      latest.ownerError.transitionId === latest.transition?.id
    ) {
      report(latest.ownerError.message)
    } else if (latest.transition) {
      const blocked = Object.entries(latest.transition.participants).filter(
        ([, p]) => !p.ready || p.error
      )
      report(
        `Upgrade ${latest.transition.phase}: ${blocked.length ? blocked.map(([id, p]) => `${latest.tabs[id]?.label ?? id.slice(0, 8)}: ${p.error ?? 'waiting for tab'}`).join('; ') : 'waiting for exclusive storage ownership'}`
      )
    }
  } catch (error) {
    report(error)
  } finally {
    ticking = false
  }
}

/** Admission and transition creation use the same transaction. App imports only
 * occur after admission; a mid-upgrade new tab cannot construct database readers.
 */
async function boot(active: Active): Promise<void> {
  diagnostics.record('selected-release', 'info', {
    releaseId: active.manifest.releaseId,
  })
  await diagnostics.step('cached-file-verification', () =>
    verifyCache(
      active.manifest,
      (value) => reportProgress('Checking installed release', value),
      startupScope()
    )
  )
  const admitted = await diagnostics.step('tab-admission', () =>
    control((s) => {
      if (s.transition || s.active?.epoch !== active.epoch) return false
      s.tabs[tabId] = {
        epoch: active.epoch,
        releaseId: active.manifest.releaseId,
        label:
          new URLSearchParams(location.search).get('session') ??
          tabId.slice(0, 8),
      }
      return true
    })
  )
  if (!admitted) return
  const finishAppStartup = diagnostics.begin('application-ready')
  runtime = window.runmeRelease = {
    active,
    tabId,
    ready: () => {
      // Notebook subscriptions repeat readiness after edits. Start background
      // caching once per page, not another full cache verification per edit.
      const firstReady = !appReady
      if (firstReady) finishAppStartup()
      appReady = true
      updatePanelVisibility()
      if (firstReady) void completeOffline(active.manifest)
      void control((s) => {
        if (s.active?.epoch === active.epoch)
          s.healthy = active.manifest.releaseId
        if (s.tabs[tabId])
          s.tabs[tabId].label =
            new URLSearchParams(location.search).get('session') ??
            tabId.slice(0, 8)
      })
    },
  }
  for (const path of active.manifest.styles) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = releasePrefix(active.manifest.releaseId) + path
    document.head.append(link)
  }
  const script = document.createElement('script')
  script.type = 'module'
  script.src =
    releasePrefix(active.manifest.releaseId) + active.manifest.appEntry
  script.onerror = () => {
    finishAppStartup('failed')
    details = true
    report(
      'Application failed to load. Open recovery to retry or select a compatible cached release.'
    )
    void render()
  }
  document.head.append(script)
  await render()
}

async function render(): Promise<void> {
  const generation = ++renderGeneration
  const s = await readControl()
  if (generation !== renderGeneration) return
  transitioning = Boolean(s.transition)
  // Normal management belongs to Information. Startup/recovery and frozen-app
  // transitions retain independent controls, including cancel/resume.
  updatePanelVisibility()
  uiKey = JSON.stringify([
    s.active?.epoch,
    s.candidate?.releaseId,
    s.transition?.id,
    s.transition?.phase,
    s.selection,
  ])
  for (const node of [...panel.children])
    if (node !== status && node !== progressBar && node !== diagnostics.element)
      node.remove()
  report(
    s.active
      ? `Runme ${s.active.manifest.webCommit.slice(0, 8)} · ${s.selection.kind === 'channel' ? s.selection.name : 'pinned'}`
      : 'Installing Runme…'
  )
  button(details ? 'Hide versions' : 'Versions', () => {
    details = !details
    return render()
  })
  if (
    s.candidate &&
    s.candidate.releaseId !== s.active?.manifest.releaseId &&
    (details || dismissedCandidate !== s.candidate.releaseId)
  ) {
    button('Upgrade all tabs', () => begin(s.candidate!))
    button('Later', async () => {
      dismissedCandidate = s.candidate!.releaseId
      details = false
      await render()
      report('Update downloaded. Your installed version stays active.')
    })
  }
  if (details || s.transition) {
    button('Follow stable', () => check({ kind: 'channel', name: 'stable' }))
    button('Follow latest', () => check({ kind: 'channel', name: 'latest' }))
    button('Check for updates', () => check())
    button('Remove unused downloads', async () => {
      const removed = await pruneUnusedCaches()
      await render()
      report(
        `Removed ${removed} unused downloads. Installed and previous releases retained.`
      )
    })
    button('Browse published releases', async () => {
      const response = await fetch('/releases/catalog.json', {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      })
      if (!response.ok)
        throw new Error(
          'Catalog unavailable; cached releases remain available below'
        )
      const catalog = await response.json()
      if (catalog.format !== 1 || !Array.isArray(catalog.releases))
        throw new Error('Unsupported release catalog')
      for (const release of catalog.releases.slice(-100).reverse()) {
        if (!releaseIdValid(release.releaseId)) continue
        button(
          `Download ${release.webCommit.slice(0, 8)} / ${release.buildId.slice(0, 8)}`,
          () => check({ kind: 'pinned', releaseId: release.releaseId })
        )
      }
    })
    if (s.active)
      button('Pin installed release', async () => {
        await control((s) => {
          s.selection = {
            kind: 'pinned',
            releaseId: s.active!.manifest.releaseId,
          }
          delete s.candidate
        })
        await render()
      })
    if (s.transition?.phase === 'prepare')
      button('Cancel upgrade', () => cancel(s.transition!.id))
    const label = document.createElement('label')
    label.textContent = 'Exact release ID '
    const input = document.createElement('input')
    input.placeholder = '<commit>-<build ID>'
    label.append(input)
    panel.append(label)
    button('Download exact release', () =>
      check({ kind: 'pinned', releaseId: input.value.trim() })
    )
    button('Retry preparation / resume', async () => {
      preparation = undefined
      ownerKey = ''
      await tick()
    })
    for (const name of await caches.keys()) {
      if (!name.startsWith('runme-release-v1-')) continue
      const cache = await caches.open(name)
      const id = name.slice('runme-release-v1-'.length)
      const response =
        (await cache.match(releasePrefix(id) + 'release.json')) ||
        (deferredFonts ? await cache.match(startupMarker(id)) : undefined)
      if (generation !== renderGeneration) return
      if (!response) continue
      try {
        const manifest = validateManifest(await response.json())
        if (manifest.releaseId !== id) continue
        if (generation !== renderGeneration) return
        if (
          id !== s.active?.manifest.releaseId ||
          s.transition?.phase === 'handoff'
        )
          button(
            `Use cached ${manifest.webCommit.slice(0, 8)} / ${manifest.buildId.slice(0, 8)}`,
            () => begin(manifest)
          )
      } catch {
        /* Incomplete/unsupported caches are never recovery choices. */
      }
    }
    if (generation !== renderGeneration) return
    const link = document.createElement('a')
    link.href = '/recovery.html' + location.search + location.hash
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'Open recovery in another tab'
    panel.append(link)
  }
}

/** Root loader is intentionally independent of React and notebook storage. */
async function main(): Promise<void> {
  if (
    !navigator.locks ||
    !('SharedWorker' in window) ||
    !navigator.serviceWorker
  )
    throw new Error(
      'Runme upgrades require SharedWorker, Web Locks and service workers in a secure browser.'
    )
  if (
    /^\/version\/[a-f0-9]{40}-[a-f0-9]{64}\/(index.html)?$/.test(
      location.pathname
    )
  )
    history.replaceState(null, '', '/' + location.search + location.hash)
  report('Starting the installed release…')
  diagnostics.record('launcher', 'info', {
    path: new URL(import.meta.url).pathname,
  })
  await installLoader()
  report('Registering this tab…')
  await diagnostics.step('tab-liveness-lock', holdTab)
  startupPrepared = true
  await startRelease()
}

/** Run admission only after loader compatibility and tab liveness are ready. */
async function startRelease(applyRequest = true): Promise<void> {
  report('Reading the installed release…')
  await diagnostics.step('initial-release-state', render)
  const query = new URLSearchParams(location.search)
  const requested = !applyRequest
    ? undefined
    : query.has('release')
      ? ({ kind: 'pinned', releaseId: query.get('release')! } as const)
      : query.has('channel')
        ? ({ kind: 'channel', name: query.get('channel')! } as Selection)
        : undefined
  if (requested) {
    try {
      await control((s) => {
        s.selection = validateSelection(requested)
        delete s.candidate
      })
    } catch (error) {
      report(error)
    }
  }
  const s = await readControl()
  if (!s.active && !s.transition) {
    await check()
    const candidate = (await readControl()).candidate
    if (candidate) await begin(candidate)
  }
  await diagnostics.step('initial-coordination', tick)
  setInterval(() => void tick(), 1000)
  setInterval(
    () =>
      void check().catch((error) =>
        report(`Installed release retained: ${String(error)}`)
      ),
    60 * 60 * 1000
  )
  window.addEventListener('pageshow', () => {
    freeze()
    void tick().then(() => {
      if (!preparation) {
        const root = document.getElementById('root')
        if (root) root.inert = false
      }
    })
  })
  if (s.active)
    void check().catch((error) =>
      report(`Installed release available. Update check: ${String(error)}`)
    )
}
/** Recovery controls must not depend on a successful settings read. A missing
 * settings service cannot be allowed to hide the only way to retry or choose a
 * release. No notebook/coordination data is cleared by these actions.
 */
function showStartupRecovery(error: unknown): void {
  panel.hidden = false
  if (error instanceof ReleaseControlError)
    diagnostics.record(`release-settings-${error.stage}`, 'failed', {
      ...error.diagnosticDetails,
      stage: `release-settings-${error.stage}`,
    })
  for (const node of [...panel.children])
    if (node !== status && node !== progressBar && node !== diagnostics.element)
      node.remove()
  report(
    `${String(error instanceof Error ? error.message : error)} Retry loading stable, or choose another release below. Browser storage must respond before Runme can safely open notebooks.`
  )
  button('Retry latest stable', () => recoverStartup())
  button('Try latest channel', () =>
    recoverStartup({ kind: 'channel', name: 'latest' })
  )
  const label = document.createElement('label')
  label.textContent = 'Exact release ID '
  const input = document.createElement('input')
  input.placeholder = '<commit>-<build ID>'
  label.append(input)
  panel.append(label)
  button('Try exact release', () =>
    recoverStartup(
      validateSelection({ kind: 'pinned', releaseId: input.value.trim() })
    )
  )
  // An expanded trace must never push the recovery actions below the fold.
  panel.append(diagnostics.element)
}

/** Prefer latest stable after a settings failure. Downloads do not need the
 * settings DB; activation still uses the usual prepare/handoff and owner lock.
 * Existing transitions are resumed, never discarded to force a new version.
 */
async function recoverStartup(
  selection: Selection = { kind: 'channel', name: 'stable' }
): Promise<void> {
  if (recoveringStartup) return
  recoveringStartup = true
  try {
    report(
      selection.kind === 'channel' && selection.name === 'stable'
        ? 'Release settings unavailable. Trying the latest stable release…'
        : 'Trying the selected recovery release…'
    )
    const candidate = await diagnostics.step('startup-fallback', () =>
      prepareStartupRecovery(
        selection,
        (value) => reportProgress('Preparing recovery release', value),
        startupScope(),
        async (candidate) => {
          if (runtime || appReady)
            throw new Error('Reload before repairing release settings.')
          await diagnostics.step('quarantine-unreadable-settings', () =>
            recoverUnreadableControl(tabId, selection, candidate)
          )
        }
      )
    )
    if (!(await readControl()).transition) await begin(candidate)
    await startRelease(false)
  } catch (error) {
    // Offline discovery must not prevent an already installed release from
    // starting if IndexedDB has recovered. Do not reapply a broken URL selection.
    try {
      const state = await readControl()
      if (state.active || state.transition) {
        await startRelease(false)
        return
      }
    } catch {
      /* Keep recovery reachable even when storage remains unavailable. */
    }
    showStartupRecovery(error)
  } finally {
    recoveringStartup = false
  }
}

window.runmeVersions = {
  uiVersion: 1,
  registerVersionUi: () => {
    versionUiUsers++
    updatePanelVisibility()
    let released = false
    return () => {
      if (released) return
      released = true
      versionUiUsers--
      updatePanelVisibility()
    }
  },
  status: () => status.textContent ?? '',
  progress: () => progress && { ...progress },
  offline: (id) => {
    const value = offlineDownloads.get(id)
    return value && { ...value }
  },
  retryOffline: async () => {
    const active = (await readControl()).active
    if (active) await completeOffline(active.manifest)
  },
  cached: cachedReleases,
  activate: async (id) => {
    const manifest = (await cachedReleases()).find((m) => m.releaseId === id)
    if (!manifest)
      throw new Error('This release does not have cached startup files')
    await begin(manifest)
  },
  pin: async () => {
    await control((s) => {
      if (!s.active) throw new Error('No installed release')
      s.selection = { kind: 'pinned', releaseId: s.active.manifest.releaseId }
      delete s.candidate
    })
    await render()
  },
  get: readControl,
  check,
  upgrade: async () => {
    const state = await readControl()
    if (!state.candidate) throw new Error('No downloaded candidate')
    await begin(state.candidate)
  },
  cancel,
  prune: pruneUnusedCaches,
  retry: async () => {
    preparation = undefined
    ownerKey = ''
    await tick()
  },
}

/** Startup-ready releases remain recovery choices even when optional fonts are
 * unavailable. Activation rechecks code bytes; this does not claim full offline readiness.
 */
async function cachedReleases(): Promise<Manifest[]> {
  const releases: Manifest[] = []
  for (const name of await caches.keys()) {
    if (!name.startsWith('runme-release-v1-')) continue
    const id = name.slice('runme-release-v1-'.length)
    const cache = await caches.open(name)
    const response =
      (await cache.match(releasePrefix(id) + 'release.json')) ||
      (deferredFonts ? await cache.match(startupMarker(id)) : undefined)
    if (!response) continue
    try {
      const manifest = validateManifest(await response.json())
      if (manifest.releaseId === id) releases.push(manifest)
    } catch {
      /* Incomplete caches are not eligible. */
    }
  }
  return releases
}
// This listener is installed before startup awaits. An old uncontrolled window
// cannot satisfy this probe, while another starting launcher can respond safely.
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data === 'runme-loader-probe')
    event.ports[0]?.postMessage('runme-loader-1')
})
void diagnostics.step('bootstrap', main).catch((error) => {
  if (startupPrepared && error instanceof ReleaseControlError) {
    diagnostics.record(`release-settings-${error.stage}`, 'failed', {
      ...error.diagnosticDetails,
      stage: `release-settings-${error.stage}`,
    })
    void recoverStartup()
  } else report(error)
})
