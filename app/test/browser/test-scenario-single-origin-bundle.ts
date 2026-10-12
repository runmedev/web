import { spawn } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

/** Run the production-artifact check in the CUJ pipeline so its screenshots
 * and network evidence use the repository's existing GCS publication path.
 */
async function checkServer(development: boolean) {
  const base = 'http://127.0.0.1:5198'
  const preview = spawn(
    'pnpm',
    [
      'exec',
      'vite',
      ...(development ? ['--force'] : ['preview']),
      '--host',
      '127.0.0.1',
      '--port',
      '5198',
      '--strictPort',
    ],
    { stdio: 'pipe', detached: process.platform !== 'win32' }
  )
  let serverOutput = ''
  preview.stderr?.on('data', (chunk) => {
    serverOutput += String(chunk)
  })
  preview.stdout?.on('data', (chunk) => {
    serverOutput += String(chunk)
  })
  try {
    const deadline = Date.now() + 20000
    while (true) {
      if (preview.exitCode !== null)
        throw new Error(`Production preview exited: ${serverOutput}`)
      try {
        if (
          stripVTControlCharacters(serverOutput).includes('Local:') &&
          (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok
        )
          break
      } catch {}
      if (Date.now() > deadline)
        throw new Error(`Production preview did not start: ${serverOutput}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    process.env.RUNME_TEST_URL = base
    const { runSingleOriginBundle } = await import('./single-origin-bundle.js')
    await runSingleOriginBundle(development)
    console.log(
      development
        ? 'PASS: Single-origin development modules and exports'
        : 'PASS: Single-origin production assets and offline persistence'
    )
  } finally {
    if (preview.pid && process.platform !== 'win32') {
      try {
        process.kill(-preview.pid, 'SIGTERM')
      } catch {}
    } else preview.kill('SIGTERM')
    // Release the port before starting the other server mode.
    if (preview.exitCode === null) {
      await new Promise<void>((resolve) =>
        preview.once('exit', () => resolve())
      )
    }
  }
}
/** Check a cold dependency optimizer too; production Rollup can hide dev-only
 * CommonJS interop failures in packages such as Excalidraw.
 */
async function main() {
  await checkServer(false)
  await checkServer(true)
}
main().catch((error) => {
  console.error('FAIL:', error)
  process.exitCode = 1
})
