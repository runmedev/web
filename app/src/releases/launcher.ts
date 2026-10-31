import {
  type Active,
  type Control,
  type Manifest,
  type ReleaseProgress,
  type Selection,
  control,
  discover,
  preferenceSource,
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
import { type ReleaseAttention, releaseAttention } from './releaseAttention'
import { holdReleaseCache } from './releaseCacheLease'
import { resolvePublishedRelease } from './releaseCatalog'
import { subscribeReleaseChanges } from './releaseChanges'
import { ReleaseControlError } from './releaseDatabase'
import { releaseDatabaseDiagnostics } from './releaseDiagnostics'
import { readOwnerTarget } from './releasePreferences'
import type { OfflineDownloadStatus, ReleaseRuntime } from './runtime'
import { startupDiagnostics } from './startupDiagnostics'
import {
  downloadRecoveryRelease,
  prepareStartupRecovery,
} from './startupRecovery'
import { upgradeLoader } from './upgradeLoader'
import { activateWorker } from './workerActivation'

const tabId = crypto.randomUUID()
/** Historical owners cannot accept an unregistered tab. Keep recovery outside
 * the app so choosing a compatible worker remains an explicit user action.
 */
class TabRegistrationRequiredError extends Error {}
/** Immutable historical owners cannot authorize tabs without IDB registration. */
function requireRegistrationFreeOwner(manifest: Manifest): void {
  if (manifest.tabAdmissionFormat !== 1 || manifest.storageControlFormat !== 1)
    throw new TabRegistrationRequiredError(
      'This release requires the older persistent storage-coordination protocol. Choose a newer release below. Existing tabs have not been reloaded.'
    )
}
const recovery = location.pathname === '/recovery.html'
const panel = document.createElement('section')
panel.id = 'runme-release-panel'
panel.setAttribute('aria-label', 'Runme versions')
panel.style.cssText =
  'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:white;color:#222;border:1px solid #aaa;border-radius:8px;padding:12px;max-width:480px;font:14px system-ui;max-height:80vh;overflow:auto'
// Recovery deliberately never imports the app. Keep its explanation and exit
// outside the dynamic controls so errors and collapsed details cannot hide them.
const recoveryIntro = document.createElement('header')
if (recovery) {
  recoveryIntro.id = 'runme-recovery-intro'
  const heading = document.createElement('h1')
  heading.textContent = 'Runme recovery'
  heading.style.cssText = 'font-size:20px;margin:0 0 8px'
  const explanation = document.createElement('p')
  explanation.textContent =
    'This page manages app versions. Your notebooks open in Runme when you return.'
  const returnLink = document.createElement('a')
  const appUrl = new URL(location.href)
  appUrl.pathname = '/'
  // Recovery requests have already been applied; returning must not replay them.
  appUrl.searchParams.delete('release')
  appUrl.searchParams.delete('channel')
  returnLink.href = appUrl.pathname + appUrl.search + appUrl.hash
  returnLink.textContent = 'Return to Runme'
  returnLink.style.cssText =
    'display:inline-block;background:#1463d6;color:white;padding:10px 16px;border-radius:6px;font-weight:600;text-decoration:none'
  recoveryIntro.append(heading, explanation, returnLink)
  panel.append(recoveryIntro)
}
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
let reloadingTab = false
let legacyPrepared = false
let renderGeneration = 0
let observing = false
let observationPending = false
let activating = false
let booting = false
let startupComplete = false
let backgroundStarted = false
let owner: SharedWorker | undefined
let dismissedCandidate: string | undefined
let appReady = false
let versionUiUsers = 0
let attentionUiUsers = 0
let attention: ReleaseAttention | undefined
let transitioning = false
let tabUpdateAvailable = false
let details = recovery
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
  if (value instanceof Error)
    attention = {
      kind: 'error',
      message: 'Version information needs attention',
    }
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
/** Historical launchers can reload on epoch changes before saving their edits. */
function legacyMigrationBlocked(): Error {
  return new TabRegistrationRequiredError(
    'Save edits and close older Runme tabs before retrying this upgrade. Their older launchers can reload before pending edits are saved. Keep this upgrade tab open.'
  )
}
/** This one-time guard is unnecessary between registration-free releases. */
async function requireClosedLegacyTabs(state: Control): Promise<boolean> {
  if (!state.active || state.active.manifest.storageControlFormat === 1)
    return false
  const locks = await navigator.locks.query()
  if (
    locks.held?.some(
      (lock) =>
        lock.name?.startsWith('runme-release-tab-') &&
        lock.name !== `runme-release-tab-${tabId}`
    )
  )
    throw legacyMigrationBlocked()
  return true
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
  panel.hidden =
    appReady &&
    versionUiUsers > 0 &&
    !recovery &&
    (attentionUiUsers > 0 || (!transitioning && !tabUpdateAvailable))
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
async function check(selection?: Selection, background = false): Promise<void> {
  await navigator.locks.request('runme-release-cache', { mode: 'shared' }, () =>
    downloadSelection(selection, background)
  )
}
async function downloadSelection(
  selection?: Selection,
  background = false
): Promise<void> {
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
  // Refreshes that find the installed/already-downloaded build need no write.
  // A new candidate stays local to this launcher; discovery does not persist it.
  const current = await readControl()
  if (
    JSON.stringify(current.selection) === JSON.stringify(selected) &&
    (!background ||
      (current.candidate?.releaseId ?? current.active?.manifest.releaseId) !==
        candidate.releaseId)
  )
    await control((s) => {
      if (JSON.stringify(s.selection) === JSON.stringify(selected))
        s.candidate = candidate
    })
  await render()
  if (appReady) void completeOffline(candidate)
}

/** Serialize explicit activations, not tab loads. A crashed launcher leaves no
 * IDB handoff to block startup; the previous installed app remains selectable.
 */
async function begin(target: Manifest): Promise<void> {
  requireRegistrationFreeOwner(target)
  if (activating) throw new Error('Activation is already running in this tab')
  await navigator.locks.request(
    'runme-release-activation',
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error(
          'Another activation is in progress; retry when it finishes.'
        )
      const releaseTarget = await holdReleaseCache(target.releaseId)
      activating = true
      try {
        await verifyCache(
          target,
          (value) => reportProgress('Verifying downloaded release', value),
          startupScope()
        )
        const current = await readControl()
        if (!current.active || (await requireClosedLegacyTabs(current))) {
          report('Updating the navigation loader for offline startup…')
          await upgradeLoader(navigator.serviceWorker)
        }
        if (
          runtime &&
          (!runtime.prepareReload || target.tabRecoveryFormat !== 1) &&
          !legacyPrepared
        ) {
          if (!runtime.prepare)
            throw new Error(
              'Wait for this tab to finish loading before activating a release'
            )
          await runtime.prepare()
          legacyPrepared = true
          freeze()
        }
        const previousTarget = await readOwnerTarget()
        const next = {
          manifest: target,
          epoch: Math.max(
            Date.now(),
            (previousTarget?.epoch ?? 0) + 1,
            (current.active?.epoch ?? 0) + 1
          ),
        }
        await control((s) => {
          s.transition = {
            id: crypto.randomUUID(),
            from: current.active,
            target,
            epoch: next.epoch,
            phase: 'handoff',
            participants: {},
          }
          delete s.ownerError
        })
        report('Starting the selected storage worker; other tabs stay open…')
        const replacement = await activateWorker(next)
        owner?.port.close()
        owner = replacement
        // Only a ready worker can become the saved installed release. There are no
        // persistent initializing/ready/error/cancellation records.
        await control((s) => {
          if (s.active?.manifest.releaseId !== target.releaseId)
            s.previous = s.active
          s.active = next
          delete s.transition
          delete s.ownerError
        })
        if (runtime) await reloadThisTab()
        else await loadInstalledRelease()
        await render()
      } catch (error) {
        await control((s) => {
          s.ownerError = { message: String(error) }
        }).catch(() => {})
        if (legacyPrepared) location.reload()
        throw error
      } finally {
        releaseTarget()
        activating = false
        if (observationPending) void observeRelease()
      }
    }
  )
}

/** Explicit retries create a fresh worker generation; startup never resumes an
 * abandoned transition from another tab or rewrites release preferences.
 */
async function activateSelectedRelease(): Promise<void> {
  const selected = await readControl()
  const target = selected.transition?.target ?? selected.active?.manifest
  if (!target) throw new Error('Choose a downloaded release first')
  await begin(target)
}

/** Only a user action or this tab's own activation can authorize its reload.
 * Checkpoint failure leaves the mounted editor alive; no peer participates.
 */
async function reloadThisTab(): Promise<void> {
  if (reloadingTab) return
  reloadingTab = true
  freeze()
  try {
    if (runtime && !legacyPrepared) {
      const selected = (await readControl()).active
      if (runtime.prepareReload && selected?.manifest.tabRecoveryFormat !== 1)
        throw new Error(
          'The selected release cannot restore this tab’s pending-save checkpoints. Keep this tab open and export edits, or select a release with tab recovery support.'
        )
      if (runtime.prepareReload) await runtime.prepareReload()
      else if (runtime.prepare) await runtime.prepare()
      else
        throw new Error(
          'This tab is not ready to preserve its editors; wait before reloading'
        )
    }
    location.reload()
  } catch (error) {
    reloadingTab = false
    const root = document.getElementById('root')
    if (root) root.inert = false
    throw error
  }
}

/** Cancellation discards only this launcher's local attempt; saved preferences
 * and other tabs are unchanged. A running activation must finish/drain first.
 */
async function cancel(): Promise<void> {
  if (activating) throw new Error('Wait for the current activation to finish')
  await control((s) => {
    delete s.transition
    delete s.ownerError
  })
  await render()
}

/** Notifications refresh the badge; they never activate a worker or reload.
 * There is no periodic tab reconciliation or tab-record cleanup on startup.
 */
async function observeRelease(): Promise<void> {
  if (!startupComplete) return
  if (observing || activating || booting) {
    observationPending = true
    return
  }
  observationPending = false
  observing = true
  try {
    const state = await readControl()
    await render(state)
    if (!runtime && !recovery && !state.transition)
      await loadInstalledRelease(state)
  } catch (error) {
    if (!runtime) showStartupRecovery(error)
    else report(error)
  } finally {
    observing = false
    if (observationPending) void observeRelease()
  }
}

/** Loading an installed app reads settings without registering the tab in IDB.
 * A pending handoff requires an explicit retry; startup never starts its target.
 */
async function loadInstalledRelease(state?: Control): Promise<void> {
  if (runtime || recovery || booting) return
  booting = true
  try {
    const selected =
      state ?? (await diagnostics.step('installed-release-read', readControl))
    if (selected.transition) {
      details = true
      await render(selected)
      report('An upgrade is pending. Resume it from Versions when ready.')
      return
    }
    if (selected.active) await boot(selected.active)
  } finally {
    booting = false
    if (observationPending) void observeRelease()
  }
}

/** Protect lazy assets with a lifetime lease, then recheck selection read-only.
 * A later activation can race this snapshot: the worker fences requests against
 * its current epoch before effects, independently of any per-tab DB record.
 */
async function boot(active: Active): Promise<void> {
  requireRegistrationFreeOwner(active.manifest)
  diagnostics.record('selected-release', 'info', {
    releaseId: active.manifest.releaseId,
  })
  // The per-release lease alone serializes with deletion. Joining the global
  // cache lock would let unrelated downloads or cleanup delay cached startup.
  const releaseCache = await diagnostics.step('release-cache-lease', () =>
    holdReleaseCache(active.manifest.releaseId)
  )
  try {
    await diagnostics.step('cached-file-verification', () =>
      verifyCache(
        active.manifest,
        (value) => reportProgress('Checking installed release', value),
        startupScope()
      )
    )
    const current = await diagnostics.step(
      'selected-release-recheck',
      readControl
    )
    if (
      current.transition ||
      current.active?.epoch !== active.epoch ||
      current.active.manifest.releaseId !== active.manifest.releaseId
    ) {
      releaseCache()
      return
    }
  } catch (error) {
    releaseCache()
    throw error
  }
  const finishAppStartup = diagnostics.begin('application-ready')
  runtime = window.runmeRelease = {
    active,
    storage: await readOwnerTarget(),
    tabId,
    ready: () => {
      // Notebook subscriptions repeat readiness after edits. Start background
      // caching once per page, not another full cache verification per edit.
      const firstReady = !appReady
      if (firstReady) finishAppStartup()
      appReady = true
      updatePanelVisibility()
      if (firstReady) void completeOffline(active.manifest)
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

async function render(state?: Control): Promise<void> {
  const generation = ++renderGeneration
  const s = state ?? (await readControl())
  if (generation !== renderGeneration) return
  attention = releaseAttention(s, runtime?.active.manifest.releaseId)
  transitioning = Boolean(s.transition)
  tabUpdateAvailable = Boolean(
    runtime &&
      s.active &&
      runtime.active.manifest.releaseId !== s.active.manifest.releaseId
  )
  // Normal management belongs to Information. Startup/recovery and frozen-app
  // transitions retain independent controls, including cancel/resume.
  updatePanelVisibility()
  for (const node of [...panel.children])
    if (
      node !== status &&
      node !== progressBar &&
      node !== diagnostics.element &&
      node !== recoveryIntro
    )
      node.remove()
  report(
    s.active
      ? `Runme ${s.active.manifest.webCommit.slice(0, 8)} · ${s.selection.kind === 'channel' ? s.selection.name : 'pinned'}`
      : 'Installing Runme…'
  )
  if (s.ownerError) report(s.ownerError.message)
  else if (s.transition)
    report(
      activating
        ? 'Activating the selected release; other tabs stay open…'
        : 'An upgrade is pending. Choose Retry worker activation to resume it; other tabs stay open.'
    )
  if (tabUpdateAvailable) {
    report(
      'The selected application version has changed. Reload this tab when ready; other tabs stay open.'
    )
    button('Preserve edits and reload this tab', reloadThisTab)
  }
  button(details ? 'Hide versions' : 'Versions', () => {
    details = !details
    return render()
  })
  if (
    s.candidate &&
    s.candidate.releaseId !== s.active?.manifest.releaseId &&
    (details || dismissedCandidate !== s.candidate.releaseId)
  ) {
    button('Activate release and update this tab', () => begin(s.candidate!))
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
      button('Cancel upgrade', () => cancel())
    const label = document.createElement('label')
    label.textContent = 'Commit SHA or release ID '
    const input = document.createElement('input')
    input.placeholder = '<commit>-<build ID>'
    label.append(input)
    panel.append(label)
    button('Download exact release', async () =>
      check({
        kind: 'pinned',
        releaseId: await resolvePublishedRelease(input.value),
      })
    )
    button('Retry worker activation', async () => {
      await activateSelectedRelease()
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
    /^\/version\/[a-f0-9]{40}-[a-f0-9]{64}\/(index.html|launcher.html)?$/.test(
      location.pathname
    )
  )
    history.replaceState(null, '', '/' + location.search + location.hash)
  report('Starting the installed release…')
  diagnostics.record('launcher', 'info', {
    path: new URL(import.meta.url).pathname,
    source:
      document.documentElement.dataset.runmeLauncherSource ?? 'legacy-shell',
    bootstrapLauncher:
      document.documentElement.dataset.runmeLauncher ?? 'unknown',
  })
  await installLoader()
  report('Registering this tab…')
  await diagnostics.step('tab-liveness-lock', holdTab)
  startupPrepared = true
  await startRelease()
}

/** Read selection only after loader compatibility and tab liveness are ready. */
async function startRelease(applyRequest = true): Promise<void> {
  report('Reading the installed release…')
  await diagnostics.step('initial-release-state', render)
  diagnostics.record('release-preferences', 'info', {
    source: preferenceSource(),
  })
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
  if (!s.active && !s.transition && !recovery) {
    await check()
    const candidate = (await readControl()).candidate
    if (candidate) await begin(candidate)
  }
  await loadInstalledRelease()
  startupComplete = true
  if (!backgroundStarted) {
    backgroundStarted = true
    subscribeReleaseChanges(() => void observeRelease())
    window.addEventListener('pageshow', () => void observeRelease())
    // Discovery can download a channel release, but cannot activate it.
    setInterval(() => void check(undefined, true).catch(report), 60 * 60 * 1000)
  }
  if (s.active) void check(undefined, true).catch(report)
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
      trace: JSON.stringify(error.trace ?? null),
      stage: `release-settings-${error.stage}`,
    })
  for (const node of [...panel.children])
    if (
      node !== status &&
      node !== progressBar &&
      node !== diagnostics.element &&
      node !== recoveryIntro
    )
      node.remove()
  report(
    error instanceof TabRegistrationRequiredError
      ? error.message
      : `${String(error instanceof Error ? error.message : error)} Retry the installed release, or explicitly choose another compatible release below. Stored notebooks have not been removed.`
  )
  button('Retry installed release', async () => {
    try {
      await startRelease(false)
    } catch (error) {
      showStartupRecovery(error)
    }
  })
  button('Retry latest stable', () => recoverStartup())
  button('Try latest channel', () =>
    recoverStartup({ kind: 'channel', name: 'latest' })
  )
  const label = document.createElement('label')
  label.textContent = 'Commit SHA or release ID '
  const input = document.createElement('input')
  input.placeholder = '<commit>-<build ID>'
  label.append(input)
  panel.append(label)
  input.value = new URLSearchParams(location.search).get('release') ?? ''
  button('Try exact release', async () =>
    recoverStartup({
      kind: 'pinned',
      releaseId: await resolvePublishedRelease(input.value),
    })
  )
  // An expanded trace must never push the recovery actions below the fold.
  panel.append(diagnostics.element)
}

/** Explicit recovery may select latest stable after a settings failure. Downloads do not need the
 * settings DB; activation still uses worker handoff and the exclusive owner lock.
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
        },
        requireRegistrationFreeOwner
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
  reloadTab: reloadThisTab,
  diagnostics: releaseDatabaseDiagnostics,
  prepareRecovery: (selection) =>
    downloadRecoveryRelease(
      validateSelection(selection),
      (value) => reportProgress('Preparing recovery release', value),
      startupScope()
    ),
  recover: async (selection) => {
    const candidate = await prepareStartupRecovery(
      validateSelection(selection),
      (value) => reportProgress('Preparing recovery release', value),
      startupScope(),
      undefined,
      requireRegistrationFreeOwner
    )
    await begin(candidate)
  },
  uiVersion: 1,
  attention: () => attention,
  registerVersionUi: (options) => {
    versionUiUsers++
    if (options?.attention) attentionUiUsers++
    updatePanelVisibility()
    let released = false
    return () => {
      if (released) return
      released = true
      versionUiUsers--
      if (options?.attention) attentionUiUsers--
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
    await activateSelectedRelease()
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
  if (startupPrepared) {
    showStartupRecovery(error)
  } else report(error)
})
