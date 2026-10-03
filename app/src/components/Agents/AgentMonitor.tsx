import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  resolveAgentMonitor,
  mountAgentMonitor,
} from '../../lib/agents/runtime'
import {
  parseMonitorDescriptor,
  type AgentItem,
  type AgentMonitorDescriptor,
} from '../../lib/agents/types'

/** Unknown API objects remain readable without enabling active HTML or scripts. */
function Details({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="my-2">
      <summary className="cursor-pointer text-sm">{title}</summary>
      <pre className="overflow-auto whitespace-pre-wrap rounded bg-nb-surface-2 p-3 text-xs [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

/** Render message content as safe GFM; tool calls retain their full structured payload. */
export function AgentItemView({ item }: { item: AgentItem }) {
  if (item.type !== 'message')
    return (
      <Details
        title={`${item.type} · ${item.status ?? 'unknown'}`}
        value={item}
      />
    )
  return (
    <article
      className="border-b border-nb-border-strong py-4"
      data-testid="agent-message"
    >
      <header className="mb-2 flex flex-wrap gap-2 text-xs text-nb-text-muted">
        <strong className="text-nb-text">
          {item.role === 'user'
            ? 'You'
            : item.role === 'assistant'
              ? 'Assistant'
              : (item.role ?? 'Message')}
        </strong>
        {item.phase && <span>{item.phase.replace(/_/g, ' ')}</span>}
        <span>{item.status ?? 'unknown'}</span>
      </header>
      <div
        data-testid="agent-message-content"
        className="space-y-2 text-sm leading-relaxed [overflow-wrap:anywhere] [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-nb-surface-2 [&_pre]:p-3 [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline"
      >
        {(item.content ?? []).map((part, index) => {
          const text =
            typeof part?.text === 'string'
              ? part.text
              : typeof part?.refusal === 'string'
                ? part.refusal
                : null
          if (text !== null)
            return (
              <ReactMarkdown
                key={index}
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  a: ({ children, href }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  img: ({ alt }) => <span>[Image: {alt || 'attachment'}]</span>,
                }}
              >
                {text}
              </ReactMarkdown>
            )
          return (
            <Details
              key={index}
              title={String(part?.type ?? 'Content')}
              value={part}
            />
          )
        })}
      </div>
      <Details title="Message details" value={item} />
    </article>
  )
}

/** React observes the domain store; hiding the widget for editing keeps it mounted. */
function Monitor({ descriptor }: { descriptor: AgentMonitorDescriptor }) {
  const monitor = useMemo(() => resolveAgentMonitor(descriptor), [descriptor])
  const state = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot)
  const viewport = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => mountAgentMonitor(monitor), [monitor])
  useEffect(() => {
    if (!viewport.current) return
    if (state.historical) viewport.current.scrollTop = 0
    else if (follow.current)
      viewport.current.scrollTop = viewport.current.scrollHeight
  }, [state.items, state.historical])
  const latest = () => {
    follow.current = true
    monitor.latest()
    if (viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight
  }
  const active =
    state.connection === 'live' || state.connection === 'connecting'
  return (
    <section
      aria-label="Agent session monitor"
      data-testid="agent-monitor"
      className="p-4 text-nb-text"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div data-testid="agent-monitor-heading">
          <strong>Agent session</strong>
          <p className="font-mono text-xs [overflow-wrap:anywhere]">
            {descriptor.sessionId}
          </p>
        </div>
        <button
          className="rounded border px-3 py-1 text-sm"
          onClick={() => (active ? monitor.pause() : void monitor.connect())}
        >
          {active
            ? 'Pause monitoring'
            : state.connection === 'paused'
              ? 'Resume monitoring'
              : 'Connect'}
        </button>
      </header>
      <p role="status" className="my-3 text-xs">
        Session: {String(state.session?.status ?? 'unknown')} · Root turn:{' '}
        {String(state.turn?.status ?? 'unknown')} · Connection:{' '}
        {state.connection}
      </p>
      {state.error && (
        <p
          role="alert"
          className="my-2 rounded bg-red-50 p-3 text-sm text-red-800"
        >
          {state.error}
        </p>
      )}
      {state.turn?.error != null && (
        <Details title="Turn error" value={state.turn.error} />
      )}
      {state.session?.error != null && (
        <Details title="Session error" value={state.session.error} />
      )}
      <nav
        aria-label="Agent history pages"
        className="flex flex-wrap items-center gap-2 border-y py-2 text-sm"
      >
        <button
          className="rounded border px-3 py-1 disabled:opacity-40"
          disabled={!state.hasOlder || state.loadingPage}
          onClick={() => void monitor.older()}
        >
          Older
        </button>
        <button
          className="rounded border px-3 py-1 disabled:opacity-40"
          disabled={!state.hasNewer || state.loadingPage}
          onClick={() => void monitor.newer()}
        >
          Newer
        </button>
        <button className="rounded border px-3 py-1" onClick={latest}>
          Latest{state.newActivity ? ` (${state.newActivity} updates)` : ''}
        </button>
        <span className="text-xs text-nb-text-muted">
          {state.loadingPage
            ? 'Loading…'
            : state.historical
              ? `${state.items.length} earlier items`
              : `Latest ${state.items.length} items`}
        </span>
      </nav>
      <div
        ref={viewport}
        data-testid="agent-monitor-timeline"
        aria-label="Agent messages and tools"
        tabIndex={0}
        className="max-h-[32rem] min-h-24 overflow-auto"
        onScroll={() => {
          const element = viewport.current
          if (element)
            follow.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              48
        }}
      >
        {!state.items.length && (
          <p className="py-6 text-sm text-nb-text-muted">
            {state.connection === 'connecting'
              ? 'Loading session history…'
              : state.session
                ? 'No saved items yet.'
                : 'Run this cell or Connect to load session history.'}
          </p>
        )}
        {state.items.map((item, index) => (
          <AgentItemView key={item.id ?? `legacy-${index}`} item={item} />
        ))}
      </div>
      {Array.isArray(state.session?.required_actions) &&
        state.session.required_actions.length > 0 && (
          <Details
            title="Required actions — respond through your agent client"
            value={state.session.required_actions}
          />
        )}
      <Details
        title={`Activity (${state.events.length} recent events)`}
        value={state.events}
      />
    </section>
  )
}

/** Malformed or future output versions produce a local diagnostic, not a broken notebook. */
export function AgentMonitorOutput({ value }: { value: string }) {
  const descriptor = useMemo(() => parseMonitorDescriptor(value), [value])
  return descriptor ? (
    <Monitor key={descriptor.id} descriptor={descriptor} />
  ) : (
    <p role="alert" className="p-3">
      Unsupported or malformed agent monitor output. Edit and rerun the cell.
    </p>
  )
}
