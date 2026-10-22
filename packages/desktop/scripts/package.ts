import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertLinuxBinary, getTarget } from './target.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = getTarget()
const staging = await mkdtemp(path.join(os.tmpdir(), 'runme-package-'))
try {
  const source = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8')
  )
  // The main/preload builds include JS dependencies. Ship only those outputs,
  // public assets, and an explicitly supplied runner; never the checkout/profile.
  await writeFile(
    path.join(staging, 'package.json'),
    JSON.stringify({
      name: 'runme',
      productName: 'Runme',
      version: source.version,
      main: 'dist/main.cjs',
    })
  )
  await cp(path.join(root, 'dist'), path.join(staging, 'dist'), {
    recursive: true,
  })
  const extraResource = [path.join(root, 'web')]
  try {
    await readFile(
      path.join(
        root,
        'runner',
        target.platform === 'win32' ? 'runme.exe' : 'runme'
      )
    )
    extraResource.push(path.join(root, 'runner'))
    if (target.platform === 'linux')
      await assertLinuxBinary(path.join(root, 'runner/runme'), target.arch)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const outputs = await packager({
    dir: staging,
    name: 'Runme',
    out: path.join(root, 'release'),
    electronVersion: source.devDependencies.electron,
    download: { cacheRoot: process.env.electron_config_cache },
    asar: true,
    prune: false,
    overwrite: true,
    extraResource,
    appBundleId: 'dev.runme.desktop',
    executableName: 'runme-desktop',
    ...target,
  })
  if (target.platform === 'linux') {
    const output = outputs[0]
    await assertLinuxBinary(path.join(output, 'runme-desktop'), target.arch)
    await cp(
      path.join(root, 'scripts/start-headless.sh'),
      path.join(output, 'start-headless.sh')
    )
    await chmod(path.join(output, 'start-headless.sh'), 0o755)
    await cp(
      path.join(root, 'dist/headless.cjs'),
      path.join(output, 'start-headless.cjs')
    )
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    const dirty = Boolean(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }).trim()
    )
    const name = `runme-desktop-linux-${target.arch}-${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`
    const manifest = {
      ...target,
      commit,
      dirty,
      electronVersion: source.devDependencies.electron,
      runnerIncluded: extraResource.length > 1,
      builtAt: new Date().toISOString(),
    }
    await writeFile(
      path.join(output, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    )
    const archive = path.join(root, 'release', `${name}.tar.gz`)
    execFileSync(
      'tar',
      ['-czf', archive, '-C', path.dirname(output), path.basename(output)],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } }
    )
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    await writeFile(
      `${archive}.sha256`,
      `${hash.digest('hex')}  ${path.basename(archive)}\n`
    )
    await writeFile(`${archive}.json`, JSON.stringify(manifest, null, 2) + '\n')
    process.stdout.write(`Linux archive: ${archive}\n`)
  }
  process.stdout.write(`Packaged: ${outputs.join(', ')}\n`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
