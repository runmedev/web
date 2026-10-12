import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)
export const EXCALIDRAW_ASSET_BASE = '/assets/excalidraw/0.18.1/'

/** Emit the pinned package's dynamically resolved fonts alongside Vite assets.
 * Excalidraw 0.18.1 appends a CDN fallback even with EXCALIDRAW_ASSET_PATH set.
 * Redirect that fallback locally too, including missing-font and export paths.
 */
export function localExcalidraw(): Plugin {
  const files = new Map<string, Buffer>()
  let building = false
  return {
    name: 'runme-local-excalidraw',
    enforce: 'pre',
    configResolved(config) {
      building = config.command === 'build'
    },
    async buildStart() {
      const root = path.resolve(
        path.dirname(require.resolve('@excalidraw/excalidraw')),
        '../..'
      )
      const pkg = JSON.parse(
        await readFile(path.join(root, 'package.json'), 'utf8')
      )
      if (pkg.version !== '0.18.1')
        this.error(
          'Review Excalidraw font layout and fallback before upgrading'
        )
      async function collect(directory: string, relative = ''): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const name = path.posix.join(relative, entry.name)
          if (entry.isDirectory())
            await collect(path.join(directory, entry.name), name)
          else
            files.set(
              `${EXCALIDRAW_ASSET_BASE}fonts/${name}`,
              await readFile(path.join(directory, entry.name))
            )
        }
      }
      await collect(path.join(root, 'dist/prod/fonts'))
      // Retain the notices for the newly self-hosted application fonts.
      for (const font of ['pt-sans', 'fira-mono']) {
        const fontRoot = path.dirname(
          require.resolve(`@fontsource/${font}/400.css`)
        )
        files.set(
          `/assets/licenses/${font}.txt`,
          await readFile(path.join(fontRoot, 'LICENSE'))
        )
      }
      if (!files.size) this.error('Excalidraw fonts are missing')
      if (building)
        for (const [url, source] of files)
          this.emitFile({ type: 'asset', fileName: url.slice(1), source })
    },
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist/')) return
      const fallback = /`https:\/\/esm\.sh\/.*?\/dist\/prod\/`/g
      if (!fallback.test(code)) return
      return {
        code: code.replace(
          fallback,
          `new URL(${JSON.stringify(EXCALIDRAW_ASSET_BASE)}, window.location.origin).href`
        ),
        map: null,
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost').pathname
        const file = files.get(url)
        if (!file) return next()
        res.setHeader(
          'Content-Type',
          url.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'
        )
        res.end(file)
      })
    },
  }
}
