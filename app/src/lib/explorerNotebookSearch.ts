import { isExcalidrawFileName } from '../storage/excalidraw'
import {
  type NotebookStoreItem,
  NotebookStoreItemType,
} from '../storage/notebook'
import { isNotebookFileName } from './notebookFormat'
import { appState } from './runtime/AppState'

export type ExplorerNotebook = { uri: string; name: string; folder: string }

/** Walk mounted Explorer folders once per dialog, including collapsed folders.
 * Only folder listings and item metadata are needed to match notebook names.
 */
export async function* explorerNotebookBatches(signal: AbortSignal) {
  const queue: { uri: string; folder: string; item?: NotebookStoreItem }[] =
    appState.getWorkspaceItems().map((uri) => ({ uri, folder: '' }))
  const seen = new Set<string>()
  let batch: ExplorerNotebook[] = []
  let lastPublished = 0
  let incomplete = false
  for (let i = 0; i < queue.length && !signal.aborted; i++) {
    const { uri, folder, item: listed } = queue[i]
    if (seen.has(uri)) continue
    seen.add(uri)
    const fs = uri.startsWith('fs://') ? appState.filesystemStore : null
    const store =
      fs ?? (uri.startsWith('local://') ? appState.localNotebooks : null)
    if (!store) {
      incomplete = true
      continue
    }
    try {
      const item = listed ?? (await store.getMetadata(uri))
      if (signal.aborted) return
      if (!item) continue
      if (item.type === NotebookStoreItemType.Folder) {
        const path = folder ? folder + '/' + item.name : item.name
        if (fs) {
          for (const child of await fs.list(uri, signal)) {
            queue.push({ uri: child.uri, folder: path, item: child })
          }
        } else {
          for (const child of item.children)
            queue.push({ uri: child, folder: path })
        }
      } else if (
        isNotebookFileName(item.name) &&
        !isExcalidrawFileName(item.name)
      ) {
        batch.push({ uri, name: item.name, folder })
      }
    } catch {
      // One inaccessible mount must not hide matches from the other folders.
      incomplete = true
    }
    if (
      batch.length &&
      (batch.length >= 32 || performance.now() - lastPublished >= 80)
    ) {
      yield { batch, incomplete }
      batch = []
      lastPublished = performance.now()
    }
  }
  yield { batch, incomplete }
}

/** Rank literal prefixes, then substrings, then ordered fuzzy matches. */
export function matchExplorerNotebooks(
  notebooks: ExplorerNotebook[],
  text: string
) {
  const query = text.trim().toLowerCase()
  if (!query) return []
  const ranked = notebooks.flatMap((notebook) => {
    const name = notebook.name.toLowerCase()
    const start = name.indexOf(query)
    if (start >= 0)
      return [{ notebook, rank: start === 0 ? 0 : 1, distance: start }]
    let at = -1
    for (const char of query) {
      at = name.indexOf(char, at + 1)
      if (at === -1) return []
    }
    return [{ notebook, rank: 2, distance: at }]
  })
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.distance - b.distance ||
      a.notebook.name.localeCompare(b.notebook.name) ||
      a.notebook.folder.localeCompare(b.notebook.folder)
  )
  return ranked.map((result) => result.notebook)
}
