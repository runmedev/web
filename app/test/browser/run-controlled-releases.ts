import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Build immutable fixtures, run the Go static publisher, and exercise the real
 * browser lifecycle. Keep the snapshots for diagnostics until the process exits.
 */
async function main() {
  const root = resolve('..')
  const dir = await mkdtemp(join(tmpdir(), 'runme-release-cuj-'))
  const output = resolve('test/browser/test-output/controlled-releases')
  await mkdir(output, { recursive: true })
  const ids = [
    'a'.repeat(40) + '-' + 'b'.repeat(64),
    'c'.repeat(40) + '-' + 'd'.repeat(64),
    'e'.repeat(40) + '-' + 'f'.repeat(64),
    '1'.repeat(40) + '-' + '2'.repeat(64),
  ]
  // Preserve the production snapshot before fixture builds mutate app/dist.
  const candidate = process.env.RUNME_RELEASE_CANDIDATE
  if (candidate) await cp(candidate, join(dir, 'b'), { recursive: true })
  let baseline = process.env.RUNME_RELEASE_BASELINE
  const baselineCommit = process.env.RUNME_RELEASE_BASELINE_COMMIT
  if (baselineCommit && !baseline) {
    if (!/^[a-f0-9]{40}$/.test(baselineCommit))
      throw new Error('Expected exact compatibility baseline commit')
    const source = join(dir, 'baseline-source')
    // Build frozen source with its own lockfile. CI fetches history so this is
    // independent of moving branch heads and requires no extra remote fetch.
    for (const [command, args, cwd] of [
      ['git', ['clone', '--shared', '--no-checkout', root, source], root],
      ['git', ['checkout', '--detach', baselineCommit], source],
      ['pnpm', ['install', '--frozen-lockfile'], source],
      ['pnpm', ['run', 'build:renderers'], source],
      ['pnpm', ['run', 'build:console'], source],
      ['pnpm', ['run', 'build:app'], source],
    ] as [string, string[], string][]) {
      const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, VITE_RUNME_RELEASE_ID: ids[0] },
        stdio: 'inherit',
      })
      if (result.status !== 0)
        throw new Error(
          `Compatibility baseline failed: ${command} ${args.join(' ')}`
        )
    }
    baseline = join(source, 'app', 'dist')
  }
  if (baseline) await cp(baseline, join(dir, 'a'), { recursive: true })
  for (const [index, name] of ['a', 'b', 'broken', 'broken-owner'].entries()) {
    if ((name === 'b' && candidate) || (name === 'a' && baseline)) continue
    const result = spawnSync('pnpm', ['exec', 'vite', 'build'], {
      env: { ...process.env, VITE_RUNME_RELEASE_ID: ids[index] },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    await writeFile(
      join(output, `build-${name}.log`),
      result.stdout + result.stderr
    )
    if (result.status !== 0)
      throw new Error(`Build ${name} failed; see ${output}`)
    await cp('dist', join(dir, name), { recursive: true })
  }
  // Simulate a verified release whose application entry throws. Its emitted
  // storage owner and launcher remain real production bundles for release C.
  const broken = join(dir, 'broken')
  const metadataPath = join(broken, 'release-metadata.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  metadata.appEntry = 'broken-entry.js'
  await writeFile(metadataPath, JSON.stringify(metadata))
  await writeFile(
    join(broken, 'broken-entry.js'),
    "throw new Error('Injected broken application entry')"
  )
  const brokenOwner = join(dir, 'broken-owner')
  const ownerMetadataPath = join(brokenOwner, 'release-metadata.json')
  const ownerMetadata = JSON.parse(await readFile(ownerMetadataPath, 'utf8'))
  ownerMetadata.owner.entry = 'broken-owner.js'
  await writeFile(ownerMetadataPath, JSON.stringify(ownerMetadata))
  await writeFile(
    join(brokenOwner, 'broken-owner.js'),
    "throw new Error('Injected broken storage owner entry')"
  )
  const serverBinary = join(dir, 'release-server')
  const compiled = spawnSync(
    'go',
    ['build', '-o', serverBinary, 'testing/release-server/main.go'],
    { cwd: root, stdio: 'inherit' }
  )
  if (compiled.status !== 0) throw new Error('Cannot build Go release server')
  const server = spawn(
    serverBinary,
    [
      `--a=${join(dir, 'a')}`,
      `--b=${join(dir, 'b')}`,
      `--broken=${broken}`,
      `--broken-owner=${brokenOwner}`,
      '--addr=127.0.0.1:5198',
    ],
    { cwd: root, stdio: 'inherit' }
  )
  try {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Release server exited')
      if (
        await fetch('http://127.0.0.1:5198/channels/latest.json')
          .then((r) => r.ok)
          .catch(() => false)
      )
        break
      if (i === 99) throw new Error('Release server did not start')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const test = spawn(
      process.execPath,
      [join(dirname(fileURLToPath(import.meta.url)), 'controlled-releases.js')],
      {
        env: {
          ...process.env,
          RUNME_TEST_URL: 'http://127.0.0.1:5198',
          RUNME_TEST_BROKEN: '1',
          ...(baseline ? { RUNME_RELEASE_BASELINE: baseline } : {}),
        },
        stdio: 'inherit',
      }
    )
    const code = await new Promise((resolve) => test.once('exit', resolve))
    if (code !== 0) throw new Error(`Controlled release CUJ failed: ${code}`)
    const cachedRecovery = spawn(
      process.execPath,
      [
        join(
          dirname(fileURLToPath(import.meta.url)),
          'cached-release-recovery.js'
        ),
      ],
      {
        env: { ...process.env, RUNME_TEST_URL: 'http://127.0.0.1:5198' },
        stdio: 'inherit',
      }
    )
    const recoveryCode = await new Promise((resolve) =>
      cachedRecovery.once('exit', resolve)
    )
    if (recoveryCode !== 0)
      throw new Error(`Cached recovery CUJ failed: ${recoveryCode}`)
    const startup = spawn(
      process.execPath,
      [
        join(
          dirname(fileURLToPath(import.meta.url)),
          'storage-worker-startup.js'
        ),
      ],
      {
        env: { ...process.env, RUNME_TEST_URL: 'http://127.0.0.1:5198' },
        stdio: 'inherit',
      }
    )
    const startupCode = await new Promise((resolve) =>
      startup.once('exit', resolve)
    )
    if (startupCode !== 0)
      throw new Error(`Storage startup CUJ failed: ${startupCode}`)
  } finally {
    server.kill('SIGTERM')
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
