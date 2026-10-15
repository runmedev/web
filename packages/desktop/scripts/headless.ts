import { type ChildProcess, spawn } from 'node:child_process'

async function main() {
  // Runs under Electron's bundled Node runtime, so executors need no separate Node.
  if (process.getuid?.() === 0) {
    process.stderr.write(
      'Run Runme as a non-root user with a working Chromium sandbox.\n'
    )
    process.exit(1)
  }
  const env: NodeJS.ProcessEnv = { ...process.env, RUNME_DESKTOP_HIDDEN: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let display: ChildProcess | undefined
  let electron: ChildProcess | undefined
  let stopping = false
  let status = 0
  const stop = () => {
    stopping = true
    // Keep the display alive until Electron has flushed notebook writes.
    if (electron) electron.kill('SIGTERM')
    else display?.kill('SIGTERM')
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    if (!env.DISPLAY) {
      display = spawn(
        'Xvfb',
        ['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'],
        {
          stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
        }
      )
      const xvfb = display
      env.DISPLAY = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Xvfb did not become ready')),
          10_000
        )
        let buffer = ''
        const finish = (error?: Error, number?: string) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(`:${number}`)
        }
        xvfb.once('error', () =>
          finish(new Error('Install Xvfb in the executor image'))
        )
        xvfb.once('exit', () => finish(new Error('Xvfb exited during startup')))
        xvfb.stdio[3]?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          if (buffer.includes('\n')) {
            const number = buffer.trim()
            if (!/^\d+$/.test(number))
              finish(new Error('Invalid Xvfb display number'))
            else finish(undefined, number)
          }
        })
      })
    }
    if (!stopping) {
      electron = spawn(process.execPath, process.argv.slice(2), {
        env,
        stdio: 'inherit',
      })
      display?.on('exit', () => {
        if (!stopping) {
          status = 1
          stop()
        }
      })
      status = await new Promise<number>((resolve, reject) => {
        electron!.once('error', reject)
        electron!.once('exit', (code, signal) =>
          resolve(status || code || (signal ? 1 : 0))
        )
      })
    }
  } catch (error) {
    process.stderr.write(
      `Runme launcher: ${error instanceof Error ? error.message : 'startup failed'}\n`
    )
    status = 1
  } finally {
    stopping = true
    display?.kill('SIGTERM')
  }
  process.exitCode = status
}
void main()
