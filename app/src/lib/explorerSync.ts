import { appLogger } from './logging/runtime'

export const EXPLORER_SYNC_INTERVAL_MS = 60_000
export type ExplorerSyncResult = { refreshed: string[]; failed: string[] }
type Source = {
  folders: () => string[]
  refresh: (uri: string) => Promise<void>
}

/** Coordinates toolbar, console and timed refreshes without overlapping passes. */
export class ExplorerSyncController {
  private source: Source | null = null
  private pending: Promise<ExplorerSyncResult> | null = null
  private listeners = new Set<() => void>()
  private running = false

  getSnapshot = () => this.running
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** React supplies the current tree; the timer survives ordinary tree updates. */
  connect(source: Source): () => void {
    this.source = source
    const tick = () => {
      if (document.visibilityState === 'hidden' || navigator.onLine === false)
        return
      void this.sync()
    }
    const timer = setInterval(tick, EXPLORER_SYNC_INTERVAL_MS)
    window.addEventListener('online', tick)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', tick)
      if (this.source === source) this.source = null
    }
  }

  /** Refresh known folders only. One failed mount must not block other mounts. */
  sync = (): Promise<ExplorerSyncResult> => {
    if (this.pending) return this.pending
    const source = this.source
    if (!source) return Promise.reject(new Error('File explorer is not ready.'))
    this.running = true
    this.emit()
    this.pending = this.run(source).finally(() => {
      this.pending = null
      this.running = false
      this.emit()
    })
    return this.pending
  }

  private async run(source: Source): Promise<ExplorerSyncResult> {
    const result: ExplorerSyncResult = { refreshed: [], failed: [] }
    for (const uri of new Set(source.folders())) {
      // A removed mount or unmounted explorer must not continue background work.
      if (this.source !== source) break
      if (!source.folders().includes(uri)) continue
      try {
        await source.refresh(uri)
        result.refreshed.push(uri)
      } catch (error) {
        result.failed.push(uri)
        appLogger.warn('Could not refresh explorer folder', {
          attrs: { scope: 'storage.explorer.sync', uri, error: String(error) },
        })
      }
    }
    return result
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }
}

export const explorerSync = new ExplorerSyncController()

/** Use shallow storage sync for Drive/local mirrors; filesystem list() is already live. */
export async function syncExplorerFolder(
  uri: string,
  store: {
    sync: (uri: string, options: { recursive: boolean }) => Promise<void>
  },
  refreshView: () => Promise<void>
): Promise<void> {
  if (uri.startsWith('local://folder/'))
    await store.sync(uri, { recursive: false })
  else if (!uri.startsWith('fs://'))
    throw new Error('Expected a workspace folder URI.')
  await refreshView()
}
