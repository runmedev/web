import { packager } from '@electron/packager'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
        process.platform === 'win32' ? 'runme.exe' : 'runme'
      )
    )
    extraResource.push(path.join(root, 'runner'))
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
  })
  process.stdout.write(`Packaged: ${outputs.join(', ')}\n`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
