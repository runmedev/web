import { build } from 'esbuild'
import { access, cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await access(path.join(root, '../../app/dist/index.html'))
await build({
  entryPoints: {
    main: path.join(root, 'src/main.ts'),
    preload: path.join(root, 'src/preload.ts'),
  },
  outdir: path.join(root, 'dist'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
})
await rm(path.join(root, 'web'), { recursive: true, force: true })
await cp(path.join(root, '../../app/dist'), path.join(root, 'web'), {
  recursive: true,
})
// Never implicitly package a machine-specific executable or credentials.
await rm(path.join(root, 'runner'), { recursive: true, force: true })
if (process.env.RUNME_RUNNER_BINARY) {
  await mkdir(path.join(root, 'runner'), { recursive: true })
  await cp(
    path.resolve(process.env.RUNME_RUNNER_BINARY),
    path.join(
      root,
      'runner',
      process.platform === 'win32' ? 'runme.exe' : 'runme'
    )
  )
}
process.stdout.write('Built Runme desktop runtime and bundled web assets.\n')
