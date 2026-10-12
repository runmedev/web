import { spawn } from 'node:child_process'

/** Run the production-artifact check in the CUJ pipeline so its screenshots
 * and network evidence use the repository's existing GCS publication path.
 */
async function main() {
  const base = 'http://127.0.0.1:5198'
  const preview = spawn(
    'pnpm',
    [
      'exec',
      'vite',
      'preview',
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
          serverOutput.includes('Local:') &&
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
    await runSingleOriginBundle()
    console.log('PASS: Single-origin production assets and offline persistence')
  } finally {
    if (preview.pid && process.platform !== 'win32') {
      try {
        process.kill(-preview.pid, 'SIGTERM')
      } catch {}
    } else preview.kill('SIGTERM')
  }
}
main().catch((error) => {
  console.error('FAIL:', error)
  process.exitCode = 1
})
