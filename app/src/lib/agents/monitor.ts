import { newHistoryCursor, readHistory } from './history'
import type {
  AgentEvent,
  AgentItem,
  AgentMonitorDescriptor,
  AgentObject,
  AgentStream,
  AgentTransport,
} from './types'

export type MonitorSnapshot = {
  connection: 'disconnected' | 'connecting' | 'live' | 'paused'
  session: AgentObject | null
  turn: AgentObject | null
  items: AgentItem[]
  events: AgentEvent[]
  historical: boolean
  hasOlder: boolean
  hasNewer: boolean
  newActivity: number
  loadingPage: boolean
  error: string | null
  historyError: string | null
  draft: string
  sending: boolean
  sendError: string | null
  sendNotice: string | null
}
const finalStatuses = new Set([
  'completed',
  'failed',
  'cancelled',
  'incomplete',
])
const object = (value: unknown): AgentObject | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AgentObject)
    : null
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Agent monitor request failed.'

/** Owns a continuous timeline. History grows only through user-driven reads and live events. */
export class AgentMonitor {
  private snapshot: MonitorSnapshot = {
    connection: 'disconnected',
    session: null,
    turn: null,
    items: [],
    events: [],
    historical: false,
    hasOlder: false,
    hasNewer: false,
    newActivity: 0,
    loadingPage: false,
    error: null,
    historyError: null,
    draft: '',
    sending: false,
    sendError: null,
    sendNotice: null,
  }
  private listeners = new Set<() => void>()
  private controller?: AbortController
  private stream?: AgentStream
  private pageController?: AbortController
  private live: AgentItem[] = []
  private history = newHistoryCursor()
  private historyReady = false
  private refreshTurns = new Set<string>()
  private refreshRunning = false
  private failedRefresh: string[] | null = null
  // An incremental refresh reads back to this saved boundary. Streamed IDs alone
  // are insufficient: early input/tool items may never have appeared in the stream.
  private savedBoundaries = new Map<string, string>()
  private seen = new Set<string>()
  private finalParts = new Set<string>()
  private restoredFinalIds = new Set<string>()
  private refreshTimer?: ReturnType<typeof setTimeout>
  private pendingSubmission?: { text: string; id: string }

  constructor(
    readonly descriptor: AgentMonitorDescriptor,
    private readonly transport: () => AgentTransport
  ) {}

  getSnapshot = (): MonitorSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(patch: Partial<MonitorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  /** Drafts and retry IDs stay in this controller, never in saved notebook output. */
  setDraft = (draft: string) => {
    if (!this.snapshot.sending) this.update({ draft, sendNotice: null })
  }

  /** A retry reuses the logical submission ID; reconnecting never resends input. */
  sendMessage = async (): Promise<boolean> => {
    const text = this.snapshot.draft
    if (this.snapshot.sending || !text.trim()) return false
    if (
      this.snapshot.connection !== 'live' ||
      !this.controller ||
      this.controller.signal.aborted
    ) {
      this.update({
        sendError: 'Connect or resume monitoring before sending a message.',
      })
      return false
    }
    if (this.pendingSubmission?.text !== text)
      this.pendingSubmission = { text, id: crypto.randomUUID() }
    const submission = this.pendingSubmission
    const observation = this.controller.signal
    const controller = new AbortController()
    const abort = () => controller.abort()
    observation.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 30_000)
    this.update({ sending: true, sendError: null, sendNotice: null })
    try {
      await this.transport().sendMessage(
        this.descriptor.sessionId,
        submission.text,
        submission.id,
        controller.signal
      )
      this.pendingSubmission = undefined
      this.update({ draft: '', sendNotice: 'Message sent.' })
      this.latest()
      // Hydrate the accepted user item even if the stream only reports agent output.
      this.scheduleRefresh()
      return true
    } catch {
      // Acceptance is uncertain after a network failure. Keep both text and retry ID.
      this.update({
        sendError:
          'Could not confirm delivery. Your draft is kept. Check the latest conversation before retrying: the message may already have been accepted.',
      })
      return false
    } finally {
      clearTimeout(timeout)
      observation.removeEventListener('abort', abort)
      this.update({ sending: false })
    }
  }

  /** Stop observation only. Never sends a cancel or other input event. */
  pause = () => {
    this.controller?.abort()
    this.stream?.close()
    this.pageController?.abort()
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    this.refreshTurns.clear()
    this.update({ connection: 'paused', loadingPage: false })
  }

  /** Subscribe before retrieving history, then replay only updates not already final. */
  connect = async (): Promise<void> => {
    this.pause()
    const controller = new AbortController()
    this.controller = controller
    const { signal } = controller
    this.seen.clear()
    this.finalParts.clear()
    this.update({ connection: 'connecting', error: null })
    let stream: AgentStream | undefined
    try {
      const transport = this.transport()
      stream = await transport.stream(this.descriptor.sessionId, signal)
      if (signal.aborted) {
        stream.close()
        return
      }
      this.stream = stream
      let buffered: AgentEvent[] | null = []
      let bufferedBytes = 0
      // Consume immediately; an EOF during hydration invalidates that hydration too.
      void (async () => {
        try {
          for await (const event of stream!.events) {
            if (signal.aborted) return
            if (buffered) {
              bufferedBytes += JSON.stringify(event).length
              if (buffered.length >= 2000 || bufferedBytes > 4 * 1024 * 1024)
                throw new Error(
                  'Too much activity while loading history. Reconnect to retrieve saved output.'
                )
              buffered.push(event)
            } else {
              this.applyEvent(event)
            }
          }
          if (!signal.aborted)
            throw new Error(
              'Event stream disconnected. Reconnect to retrieve saved output.'
            )
        } catch (error) {
          if (!signal.aborted) {
            this.update({
              connection: 'disconnected',
              loadingPage: false,
              error: message(error),
            })
            controller.abort()
            stream?.close()
          }
        }
      })()
      const [sessionResult, historyResult] = await Promise.allSettled([
        transport.session(this.descriptor.sessionId, signal),
        readHistory(
          transport,
          this.descriptor.sessionId,
          this.descriptor.pageSize,
          newHistoryCursor(),
          signal
        ),
      ])
      if (signal.aborted) return
      const session =
        sessionResult.status === 'fulfilled'
          ? sessionResult.value
          : this.snapshot.session
      if (historyResult.status === 'fulfilled') {
        const result = historyResult.value
        this.live = [...result.data].reverse()
        this.savedBoundaries.clear()
        const boundary = result.data.at(-1)
        if (boundary?.turn_id && boundary.id)
          this.savedBoundaries.set(boundary.turn_id, boundary.id)
        this.history = result.next
        this.historyReady = true
        this.update({
          items: this.live,
          hasOlder: result.hasMore,
          turn: result.latestTurn ?? null,
          historyError: null,
        })
      } else {
        this.update({ historyError: message(historyResult.reason) })
      }
      this.restoredFinalIds = new Set(
        this.live
          .filter((item) => item.id && finalStatuses.has(item.status ?? ''))
          .map((item) => item.id!)
      )
      this.update({
        session,
        connection: 'live',
        historical: false,
        newActivity: 0,
        ...(sessionResult.status === 'rejected'
          ? { error: message(sessionResult.reason) }
          : {}),
      })
      const events = buffered ?? []
      buffered = null
      for (const event of events) {
        if (signal.aborted || session?.status === 'failed') break
        this.applyEvent(event, true)
      }
      if (
        session?.status === 'failed' ||
        this.snapshot.session?.status === 'failed'
      ) {
        controller.abort()
        stream.close()
        this.update({
          connection: 'disconnected',
          error:
            'Session failed. Resolve the session failure before reconnecting.',
        })
      }
    } catch (error) {
      if (!signal.aborted) {
        controller.abort()
        stream?.close()
        this.update({ connection: 'disconnected', error: message(error) })
      }
    }
  }

  /** Refresh saved results without closing the stream or invalidating a pending send. */
  private scheduleRefresh(turnId?: string) {
    this.refreshTurns.add(turnId ?? '')
    if (
      this.refreshTimer ||
      this.refreshRunning ||
      this.controller?.signal.aborted
    )
      return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refreshSaved()
    }, 500)
  }

  /** Only affected turns are read; live updates arriving during a read take precedence. */
  private async refreshSaved() {
    const signal = this.controller?.signal
    if (!signal || signal.aborted) return
    this.refreshRunning = true
    const ids = [...this.refreshTurns]
    this.refreshTurns.clear()
    try {
      const api = this.transport()
      if (ids.includes('')) {
        const turns = await api.turns(this.descriptor.sessionId, signal)
        const turn = turns.data.find((value) => value.subagent_id === null)
        if (typeof turn?.id === 'string') {
          ids.push(turn.id)
          const previous = this.snapshot.turn
          if (
            !signal.aborted &&
            (!previous ||
              (previous.id === turn.id
                ? !finalStatuses.has(String(previous.status)) ||
                  finalStatuses.has(String(turn.status))
                : Number(turn.created_at ?? 0) >=
                  Number(previous.created_at ?? 0)))
          )
            this.update({ turn })
        }
      }
      for (const id of new Set(ids.filter(Boolean))) {
        if (
          id !== this.snapshot.turn?.id &&
          !this.live.some((item) => item.turn_id === id)
        )
          continue
        const boundary = this.savedBoundaries.get(id)
        const data: AgentItem[] = []
        const cursors = new Set<string>()
        let after: string | undefined
        let nextBoundary: string | undefined
        // Reconcile only this turn, back to the previous saved page. A new turn
        // is read to its beginning so a long streamed response cannot hide its prompt.
        for (;;) {
          signal.throwIfAborted()
          const page = await api.turnItems(
            this.descriptor.sessionId,
            id,
            this.descriptor.pageSize,
            after,
            signal
          )
          if (signal.aborted) return
          nextBoundary ??= page.data.at(-1)?.id ?? undefined
          data.push(...page.data)
          if (
            !page.has_more ||
            (boundary && page.data.some((item) => item.id === boundary))
          )
            break
          if (!page.last_id || cursors.has(page.last_id))
            throw new Error(
              'History returned a non-advancing pagination cursor.'
            )
          after = page.last_id
          cursors.add(after)
        }
        if (signal.aborted) return
        if (nextBoundary) this.savedBoundaries.set(id, nextBoundary)
        // Insert missing saved items relative to their known neighbors in the turn.
        // Never replay text deltas on top of the saved final version.
        const saved = [...data]
          .reverse()
          .map((item) => ({ ...item, turn_id: id }))
        this.live = [...this.live]
        for (let i = 0; i < saved.length; i++) {
          const item = saved[i]
          if (
            !item.id &&
            this.live.some(
              (value) =>
                !value.id && JSON.stringify(value) === JSON.stringify(item)
            )
          )
            continue
          const existing = item.id
            ? this.live.findIndex((value) => value.id === item.id)
            : -1
          if (existing >= 0) {
            if (
              finalStatuses.has(item.status ?? '') &&
              !finalStatuses.has(this.live[existing].status ?? '')
            )
              this.live[existing] = item
            continue
          }
          const following = saved
            .slice(i + 1)
            .find(
              (value) =>
                value.id && this.live.some((entry) => entry.id === value.id)
            )
          const position = following
            ? this.live.findIndex((value) => value.id === following.id)
            : -1
          if (position >= 0) this.live.splice(position, 0, item)
          else {
            const last = this.live.map((value) => value.turn_id).lastIndexOf(id)
            this.live.splice(last >= 0 ? last + 1 : this.live.length, 0, item)
          }
        }
        this.live = [...this.live]
        this.update({ items: this.live })
      }
      if (!signal.aborted && this.failedRefresh) {
        this.failedRefresh = null
        this.update({ historyError: null })
      }
    } catch (error) {
      if (!signal.aborted) {
        this.failedRefresh = ids
        this.update({ historyError: message(error) })
      }
    } finally {
      this.refreshRunning = false
      // A reconnect can queue work while the previous observation is aborting.
      // Drain that work using the current observation, not the stale signal.
      if (!this.controller?.signal.aborted && this.refreshTurns.size)
        this.scheduleRefresh([...this.refreshTurns][0])
    }
  }

  /** Reduce known events; retain unfamiliar events in the bounded activity log. */
  applyEvent(event: AgentEvent, replay = false) {
    if (event.session_id && event.session_id !== this.descriptor.sessionId)
      return
    if (event.event_id && this.seen.has(event.event_id)) return
    if (event.event_id) {
      this.seen.add(event.event_id)
      if (this.seen.size > 2000)
        this.seen.delete(this.seen.values().next().value!)
    }
    this.update({
      events: [...this.snapshot.events, event].slice(-100),
      newActivity: this.snapshot.historical ? this.snapshot.newActivity + 1 : 0,
    })
    const session = object(event.session)
    if (session) this.update({ session })
    const turn = object(event.turn)
    if (turn?.subagent_id === null) {
      // Late completion of an older turn cannot replace a newer running turn.
      const previous = this.snapshot.turn
      if (
        !previous ||
        (turn.id === previous.id
          ? !finalStatuses.has(String(previous.status)) ||
            finalStatuses.has(String(turn.status))
          : Number(turn.created_at ?? 0) >= Number(previous.created_at ?? 0))
      ) {
        this.update({ turn })
      }
      if (!replay && finalStatuses.has(String(turn.status)))
        this.scheduleRefresh(typeof turn.id === 'string' ? turn.id : undefined)
    }
    if (!replay && event.type === 'agent.session.requires_action' && !session)
      this.scheduleRefresh()
    if (
      [
        'error',
        'agent.session.failed',
        'agent.session.environment.failed',
      ].includes(event.type)
    ) {
      this.pause()
      this.update({
        connection: 'disconnected',
        error:
          event.type === 'error'
            ? 'The agent reported an error. Inspect Activity for details.'
            : `Agent lifecycle failure: ${event.type}`,
      })
      return
    }
    if (event.subagent_id != null) return
    const rawItem = object(event.item) as AgentItem | null
    const item = rawItem
      ? {
          ...rawItem,
          turn_id:
            rawItem.turn_id ??
            (typeof event.turn_id === 'string' ? event.turn_id : undefined),
        }
      : null
    if (event.type === 'agent.session.turn.item.added' && item) {
      if (!(replay && item.id && this.restoredFinalIds.has(item.id)))
        this.upsert(item)
      return
    }
    if (event.type === 'agent.session.turn.item.done') {
      if (item && !(replay && item.id && this.restoredFinalIds.has(item.id)))
        this.upsert(item)
      return
    }
    const isDelta = event.type === 'agent.session.turn.output_text.delta'
    const isDone = event.type === 'agent.session.turn.output_text.done'
    if (!isDelta && !isDone) return
    const id = typeof event.item_id === 'string' ? event.item_id : ''
    const index = Number(event.content_index)
    if (!id || !Number.isInteger(index) || index < 0 || index > 1000) return
    if (replay && this.restoredFinalIds.has(id)) return
    const key = `${id}:${event.output_index}:${index}`
    if (isDelta && this.finalParts.has(key)) return
    const old = this.live.find((value) => value.id === id)
    if (old && finalStatuses.has(old.status ?? '')) return
    const content = [...(old?.content ?? [])]
    const text = isDone
      ? String(event.text ?? '')
      : String(content[index]?.text ?? '') + String(event.delta ?? '')
    content[index] = { type: 'output_text', text }
    this.upsert({
      ...old,
      id,
      type: 'message',
      role: old?.role ?? 'assistant',
      turn_id: typeof event.turn_id === 'string' ? event.turn_id : old?.turn_id,
      status: old?.status ?? 'in_progress',
      content,
    })
    if (isDone) {
      this.finalParts.add(key)
      if (this.finalParts.size > 1000)
        this.finalParts.delete(this.finalParts.values().next().value!)
    }
  }

  private upsert(item: AgentItem) {
    const index = item.id
      ? this.live.findIndex((value) => value.id === item.id)
      : -1
    const next = [...this.live]
    // A delayed item.added cannot replace an authoritative final item.
    if (index >= 0) {
      if (
        finalStatuses.has(next[index].status ?? '') &&
        !finalStatuses.has(item.status ?? '')
      )
        return
      next[index] = item
    } else next.push(item)
    this.live = next
    this.update({ items: this.live })
  }

  /** The view reports whether it is following the bottom; data keeps updating either way. */
  setFollowing = (following: boolean) => {
    if (this.snapshot.historical === !following) return
    this.update({
      historical: !following,
      hasNewer: !following,
      ...(following ? { newActivity: 0 } : {}),
    })
  }

  /** Append earlier history to the same timeline; commit the cursor only after success. */
  older = async () => {
    if (
      this.snapshot.loadingPage ||
      (!this.snapshot.hasOlder && this.historyReady)
    )
      return
    const observation = this.controller?.signal
    if (
      !observation ||
      observation.aborted ||
      this.snapshot.connection !== 'live'
    )
      return
    const controller = new AbortController()
    this.pageController = controller
    const abort = () => controller.abort()
    observation.addEventListener('abort', abort, { once: true })
    this.update({ loadingPage: true, historyError: null })
    try {
      const result = await readHistory(
        this.transport(),
        this.descriptor.sessionId,
        this.descriptor.pageSize,
        this.history,
        controller.signal
      )
      if (controller.signal.aborted) return
      const ids = new Set(
        this.live.filter((item) => item.id).map((item) => item.id)
      )
      // Retry can recover a final saved item whose stream stopped at a partial
      // delta. Prefer that final record without overwriting newer live partials.
      const recovered = new Map(
        result.data
          .filter((item) => item.id && finalStatuses.has(item.status ?? ''))
          .map((item) => [item.id, item])
      )
      this.live = this.live.map((item) =>
        !finalStatuses.has(item.status ?? '') && recovered.has(item.id)
          ? recovered.get(item.id)!
          : item
      )
      const older = [...result.data]
        .reverse()
        .filter((item) => !item.id || !ids.has(item.id))
      this.live = [...older, ...this.live]
      this.history = result.next
      this.historyReady = true
      this.update({
        items: this.live,
        hasOlder: result.hasMore,
        loadingPage: false,
      })
    } catch (error) {
      if (!controller.signal.aborted)
        this.update({ loadingPage: false, historyError: message(error) })
    } finally {
      observation.removeEventListener('abort', abort)
    }
  }

  /** Retry a failed history load without disturbing the event stream. */
  retryHistory = () => {
    if (this.failedRefresh) {
      this.failedRefresh.forEach((id) => this.scheduleRefresh(id))
      return
    }
    if (!this.historyReady || this.snapshot.hasOlder) return this.older()
    this.scheduleRefresh()
  }

  /** Compatibility for notebook callers; the continuous timeline no longer has newer pages. */
  newer = async () => {
    this.latest()
  }
  latest = () => {
    this.setFollowing(true)
  }
}
