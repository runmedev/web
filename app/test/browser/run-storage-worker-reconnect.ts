import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Run the real app's Vite server and browser test with isolated storage. */
async function main() {
  const output = 'test/browser/test-output/storage-worker-reconnect'
  await mkdir(output, { recursive: true })
  const logs: string[] = []
  const server = spawn(
    'pnpm',
    ['exec', 'vite', '--host', '127.0.0.1', '--port', '5194', '--strictPort'],
    {
      env: { ...process.env, CHOKIDAR_USEPOLLING: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  server.stdout.on('data', (chunk) => logs.push(String(chunk)))
  server.stderr.on('data', (chunk) => logs.push(String(chunk)))
  try {
    for (let attempt = 0; ; attempt++) {
      if (server.exitCode !== null)
        throw new Error('Vite exited before the test')
      if (
        await fetch('http://127.0.0.1:5194/')
          .then((r) => r.ok)
          .catch(() => false)
      )
        break
      if (attempt === 99) throw new Error('Vite did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const test = spawn(
      process.execPath,
      [
        join(
          dirname(fileURLToPath(import.meta.url)),
          'storage-worker-reconnect.js'
        ),
      ],
      {
        env: { ...process.env, RUNME_TEST_URL: 'http://127.0.0.1:5194' },
        stdio: 'inherit',
      }
    )
    const code = await new Promise((resolve) => test.once('exit', resolve))
    if (code !== 0) throw new Error(`Storage reconnect test failed: ${code}`)
  } finally {
    server.kill('SIGTERM')
    await writeFile(`${output}/vite.log`, logs.join(''))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
