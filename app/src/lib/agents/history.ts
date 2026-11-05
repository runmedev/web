import type { AgentItem, AgentObject, AgentPage, AgentTransport } from './types'

/** Both cursors are needed: an item cursor is valid only within its owning turn. */
export type HistoryCursor = {
  turns: AgentObject[]
  turnsAfter?: string
  moreTurns: boolean
  itemsAfter?: string
  turnCursors: string[]
  itemCursors: string[]
}

/** Start at the newest root turn. Subagent history has separate API endpoints. */
export const newHistoryCursor = (): HistoryCursor => ({
  turns: [],
  moreTurns: true,
  turnCursors: [],
  itemCursors: [],
})

/** Reject broken pagination rather than silently skipping history or looping forever. */
function cursor<T>(page: AgentPage<T>, seen: string[]): string | undefined {
  if (!page.has_more) return undefined
  if (!page.last_id || seen.includes(page.last_id))
    throw new Error(
      'History returned a missing or non-advancing pagination cursor.'
    )
  return page.last_id
}

/** Read a bounded batch transactionally; a failed request leaves the caller's cursor intact. */
export async function readHistory(
  api: AgentTransport,
  sessionId: string,
  limit: number,
  initial: HistoryCursor,
  signal: AbortSignal
) {
  const next: HistoryCursor = {
    ...initial,
    turns: [...initial.turns],
    turnCursors: [...initial.turnCursors],
    itemCursors: [...initial.itemCursors],
  }
  let latestTurn: AgentObject | undefined
  // Empty turns and pages containing only subagents must not trigger an unbounded scan.
  for (let requests = 0; requests < 20; requests++) {
    signal.throwIfAborted()
    if (!next.turns.length) {
      if (!next.moreTurns) break
      const page = await api.turns(sessionId, signal, next.turnsAfter)
      next.turnsAfter = cursor(page, next.turnCursors)
      if (next.turnsAfter) next.turnCursors.push(next.turnsAfter)
      next.moreTurns = page.has_more
      next.turns = page.data.filter((turn) => turn.subagent_id === null)
      latestTurn ??= next.turns[0]
      continue
    }
    const turn = next.turns[0]
    if (typeof turn.id !== 'string')
      throw new Error('History returned a turn without an ID.')
    const page = await api.turnItems(
      sessionId,
      turn.id,
      limit,
      next.itemsAfter,
      signal
    )
    next.itemsAfter = cursor(page, next.itemCursors)
    if (next.itemsAfter) next.itemCursors.push(next.itemsAfter)
    if (!page.has_more) {
      next.turns.shift()
      next.itemCursors = []
    }
    const data: AgentItem[] = page.data.map((item) => ({
      ...item,
      turn_id: turn.id as string,
    }))
    if (data.length)
      return {
        data,
        next,
        latestTurn,
        hasMore: Boolean(next.turns.length || next.moreTurns),
      }
  }
  return {
    data: [] as AgentItem[],
    next,
    latestTurn,
    hasMore: Boolean(next.turns.length || next.moreTurns),
  }
}
