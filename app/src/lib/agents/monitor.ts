import type {
  AgentEvent,
  AgentItem,
  AgentMonitorDescriptor,
  AgentObject,
  AgentPage,
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

/** Owns one monitor's bounded live window, history cursor stack and stream lifecycle. */
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
  }
  private listeners = new Set<() => void>()
  private controller?: AbortController
  private stream?: AgentStream
  private pageController?: AbortController
  private live: AgentItem[] = []
  private liveHasMore = false
  private liveCursor: string | null = null
  private historyCursor: string | null = null
  private cursors: Array<string | undefined> = []
  private seen = new Set<string>()
  private finalParts = new Set<string>()
  private restoredFinalIds = new Set<string>()
  private refreshTimer?: ReturnType<typeof setTimeout>

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

  /** Stop observation only. Never sends a cancel or other input event. */
  pause = () => {
    this.controller?.abort()
    this.stream?.close()
    this.pageController?.abort()
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
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
            this.update({ connection: 'disconnected', error: message(error) })
            controller.abort()
            stream?.close()
          }
        }
      })()
      const [session, page, turns] = await Promise.all([
        transport.session(this.descriptor.sessionId, signal),
        transport.items(
          this.descriptor.sessionId,
          this.descriptor.pageSize,
          undefined,
          signal
        ),
        transport.turns(this.descriptor.sessionId, signal),
      ])
      if (signal.aborted) return
      this.installLive(page)
      this.restoredFinalIds = new Set(
        this.live
          .filter((item) => item.id && finalStatuses.has(item.status ?? ''))
          .map((item) => item.id!)
      )
      this.update({
        session,
        turn: turns.data.find((turn) => turn.subagent_id === null) ?? null,
        connection: 'live',
      })
      const events = buffered ?? []
      buffered = null
      for (const event of events) {
        if (signal.aborted || session.status === 'failed') break
        this.applyEvent(event, true)
      }
      if (
        session.status === 'failed' ||
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

  /** History is never implicitly merged with a live window: pages stay bounded. */
  private installLive(page: AgentPage<AgentItem>) {
    this.live = [...page.data].reverse().slice(-this.descriptor.pageSize)
    this.liveCursor = page.last_id
    this.liveHasMore = page.has_more
    if (!this.snapshot.historical)
      this.update({ items: this.live, hasOlder: page.has_more })
  }

  /** Refresh saved statuses after terminal turn events without replaying old deltas. */
  private scheduleRefresh() {
    if (this.refreshTimer || this.controller?.signal.aborted) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      // Full reconnect applies the documented stream-before-snapshot recovery sequence.
      void this.connect()
    }, 500)
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
        this.scheduleRefresh()
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
    const item = object(event.item) as AgentItem | null
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
    if (next.length > this.descriptor.pageSize) this.liveHasMore = true
    this.live = next.slice(-this.descriptor.pageSize)
    // The oldest displayed item is the descending-order cursor after live eviction.
    this.liveCursor = this.live[0]?.id ?? this.liveCursor
    if (!this.snapshot.historical)
      this.update({ items: this.live, hasOlder: this.liveHasMore })
  }

  older = async () => {
    if (this.snapshot.loadingPage || !this.snapshot.hasOlder) return
    const cursor = this.snapshot.historical
      ? this.historyCursor
      : this.liveCursor
    if (!cursor) {
      this.update({
        error: 'History has more items but no usable pagination cursor.',
      })
      return
    }
    await this.loadPage(cursor, [...this.cursors, cursor])
  }
  newer = async () => {
    if (this.snapshot.loadingPage) return
    if (this.cursors.length <= 1) {
      this.latest()
      return
    }
    const cursors = this.cursors.slice(0, -1)
    await this.loadPage(cursors[cursors.length - 1], cursors)
  }
  latest = () => {
    this.pageController?.abort()
    this.cursors = []
    this.update({
      historical: false,
      items: this.live,
      hasOlder: this.liveHasMore,
      hasNewer: false,
      newActivity: 0,
      loadingPage: false,
    })
  }

  private async loadPage(
    after: string | undefined,
    cursors: Array<string | undefined>
  ) {
    this.pageController?.abort()
    const controller = new AbortController()
    this.pageController = controller
    this.update({ loadingPage: true, error: null })
    try {
      const page = await this.transport().items(
        this.descriptor.sessionId,
        this.descriptor.pageSize,
        after,
        controller.signal
      )
      if (controller.signal.aborted) return
      if (page.has_more && (!page.last_id || page.last_id === after))
        throw new Error('History returned a non-advancing pagination cursor.')
      this.historyCursor = page.last_id
      this.cursors = cursors
      this.update({
        items: [...page.data].reverse(),
        historical: true,
        hasOlder: page.has_more,
        hasNewer: true,
        loadingPage: false,
      })
    } catch (error) {
      if (!controller.signal.aborted)
        this.update({ loadingPage: false, error: message(error) })
    }
  }
}
