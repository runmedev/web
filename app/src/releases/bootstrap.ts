import { launcherDescriptor, selectLauncher } from './launcherSelection'

/** Minimal, storage-independent entrypoint. Never import two launchers into one
 * document: after execution starts, recovery is an explicit new navigation. */
async function start() {
  // Other tabs probe before admitting storage owners. Answer while discovery
  // is pending: this document has no app/owner yet and can only load a protocol-1
  // launcher. Waiting for the download can exceed the worker's probe deadline.
  const respondToProbe = (event: MessageEvent) => {
    if (event.data === 'runme-loader-probe')
      event.ports[0]?.postMessage('runme-loader-1')
  }
  navigator.serviceWorker?.addEventListener('message', respondToProbe)
  const panel = document.createElement('section')
  panel.id = 'runme-bootstrap'
  const status = document.createElement('p')
  status.textContent = 'Checking the latest launcher…'
  const retry = document.createElement('button')
  retry.textContent = 'Retry loading'
  retry.onclick = () => location.reload()
  const details = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = 'Launcher diagnostics'
  const log = document.createElement('pre')
  details.append(summary, log)
  panel.append(status, retry, details)
  document.body.append(panel)
  const record = (message: string) => {
    log.textContent += `${new Date().toISOString()} ${message}\n`
  }
  try {
    const fallback = launcherDescriptor(
      JSON.parse(
        document.getElementById('runme-launcher-fallback')!.textContent!
      )
    )
    record(`Bootstrap bundled with ${fallback.releaseId}`)
    const selected = await selectLauncher(fallback, record)
    record(
      `Selected ${selected.source} launcher ${selected.descriptor.releaseId}`
    )
    status.textContent = 'Starting launcher…'
    const script = document.createElement('script')
    script.type = 'module'
    script.src = `/version/${selected.descriptor.releaseId}/${selected.descriptor.entry}`
    // Retain evidence in DOM for the launcher's diagnostic panel and automation.
    document.documentElement.dataset.runmeLauncher =
      selected.descriptor.releaseId
    document.documentElement.dataset.runmeLauncherSource = selected.source
    const timer = setTimeout(() => {
      status.textContent =
        'The launcher is taking longer than expected. You can retry loading.'
      details.open = true
      record('Waiting for launcher module after 15 seconds')
    }, 15000)
    script.onload = () => {
      clearTimeout(timer)
      // The loaded launcher has installed its own synchronous probe responder.
      navigator.serviceWorker?.removeEventListener('message', respondToProbe)
      panel.hidden = true
    }
    script.onerror = () => {
      clearTimeout(timer)
      status.textContent = 'The launcher could not load. Retry when connected.'
      details.open = true
      record('Launcher module failed; no second launcher was started')
    }
    document.head.append(script)
  } catch (error) {
    status.textContent = 'Unable to start the launcher. Retry loading.'
    details.open = true
    record(String(error))
  }
}
void start()
