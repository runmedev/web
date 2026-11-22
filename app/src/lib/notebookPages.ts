import {
  allocatePositionBetween,
  comparePositionIds,
  validatePositionId,
} from './operationLog/positions'
import type { PositionId } from './operationLog/types'

export const PAGE_PREFIX = 'runme.dev/pages/'
export const CELL_PAGE = 'runme.dev/pageId'
export const pageDeletedKey = (id: string) => PAGE_PREFIX + id + '/deleted'
export const pageNameKey = (id: string) => PAGE_PREFIX + id + '/name'
export const pagePositionKey = (id: string) => PAGE_PREFIX + id + '/position'

export interface NotebookPage {
  id: string
  name: string
  position: PositionId | null
}

/** Keep a damaged or imported page openable even if its position is missing. */
export function notebookPages(
  metadata: Record<string, string>
): NotebookPage[] {
  const pages: NotebookPage[] = []
  for (const [key, name] of Object.entries(metadata)) {
    if (!key.startsWith(PAGE_PREFIX) || !key.endsWith('/name')) continue
    const id = key.slice(PAGE_PREFIX.length, -5)
    if (!id || id.includes('/') || metadata[pageDeletedKey(id)] === 'true')
      continue
    let position = null
    try {
      const candidate = JSON.parse(metadata[pagePositionKey(id)] ?? 'null')
      validatePositionId(candidate)
      position = candidate
    } catch {
      /* Missing positions sort last by stable ID. */
    }
    pages.push({ id, name, position })
  }
  return pages.sort(
    (a, b) =>
      (a.position && b.position
        ? comparePositionIds(a.position, b.position)
        : Number(!!b.position) - Number(!!a.position)) || (a.id < b.id ? -1 : 1)
  )
}

/** Use a unique allocation site even for concurrent insertions in the same gap. */
export function pagePosition(
  left?: NotebookPage,
  right?: NotebookPage
): string {
  return JSON.stringify(
    allocatePositionBetween({
      left: left?.position ?? null,
      right: right?.position ?? null,
      actorId: crypto.randomUUID(),
      actorSequence: 1,
    })
  )
}

/** Missing and deleted page references resolve to the first page in notebook order. */
export function resolvePage(
  id: string | undefined,
  pages: NotebookPage[]
): string | undefined {
  return pages.find((p) => p.id === id)?.id ?? pages[0]?.id
}

/** Create an ordinary stable ID and preserve preexisting unassigned cells on Main. */
export function createPageProperties(
  pages: NotebookPage[],
  name: string,
  materializeMain = true
) {
  if (!name.trim()) throw new Error('A page name is required.')
  const id = crypto.randomUUID()
  const changes: Record<string, string> = { [pageNameKey(id)]: name.trim() }
  let left = pages.at(-1)
  if (!left && materializeMain) {
    const main = crypto.randomUUID()
    const position = pagePosition()
    changes[pageNameKey(main)] = 'Main'
    changes[pagePositionKey(main)] = position
    left = { id: main, name: 'Main', position: JSON.parse(position) }
  }
  changes[pagePositionKey(id)] = pagePosition(left)
  return { id, changes }
}
