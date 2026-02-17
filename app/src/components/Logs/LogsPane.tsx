import { useEffect, useState } from "react";

import { loggingRuntime, type LogEvent, type LogLevel } from "../../lib/logging/runtime";

const DEFAULT_LEVEL: LogLevel = "debug";
const DEFAULT_LIMIT = 200;

/**
 * Renders a compact JSON string for log attributes. This keeps the pane simple
 * while still exposing structured metadata needed for debugging and AI context.
 */
function formatAttrs(event: LogEvent): string | null {
  if (!event.attrs || Object.keys(event.attrs).length === 0) {
    return null;
  }

  return JSON.stringify(event.attrs);
}

/**
 * LogsPane is a read-only development panel that mirrors the VS Code
 * output/problems concept. It subscribes to the logging runtime and
 * re-renders whenever new records are added.
 */
export default function LogsPane() {
  const [minLevel, setMinLevel] = useState<LogLevel>(DEFAULT_LEVEL);
  const [events, setEvents] = useState<LogEvent[]>(() =>
    loggingRuntime.list({ minLevel: DEFAULT_LEVEL, limit: DEFAULT_LIMIT }),
  );

  useEffect(() => {
    // The logging runtime is an external state store. We subscribe here and
    // copy its latest snapshot into React state whenever it changes.
    const unsubscribe = loggingRuntime.subscribe(() => {
      setEvents(loggingRuntime.list({ minLevel, limit: DEFAULT_LIMIT }));
    });

    setEvents(loggingRuntime.list({ minLevel, limit: DEFAULT_LIMIT }));
    return unsubscribe;
  }, [minLevel]);

  return (
    <div id="logs-pane" className="flex h-full min-h-[220px] flex-col bg-[#11121a] text-slate-200">
      <div
        id="logs-pane-toolbar"
        className="flex items-center justify-between border-b border-nb-tray-border px-3 py-2"
      >
        <div id="logs-pane-title" className="text-[12.6px] font-mono font-medium">
          Logs
        </div>
        <label id="logs-pane-filter" className="flex items-center gap-2 text-xs">
          <span id="logs-pane-filter-label">Minimum level</span>
          <select
            id="logs-pane-filter-select"
            value={minLevel}
            onChange={(event) => setMinLevel(event.target.value as LogLevel)}
            className="rounded border border-nb-border bg-[#1b1d27] px-2 py-1 text-xs"
          >
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>
      </div>

      <div id="logs-pane-content" className="flex-1 overflow-auto p-2 font-mono text-xs">
        {events.length === 0 ? (
          <div id="logs-pane-empty" className="text-slate-400">
            No log entries for this filter.
          </div>
        ) : (
          <ul id="logs-pane-list" className="space-y-1">
            {events.map((event) => {
              const attrsText = formatAttrs(event);

              return (
                <li
                  id={`logs-pane-event-${event.id}`}
                  key={event.id}
                  className="rounded border border-white/10 bg-black/20 px-2 py-1"
                >
                  <div id={`logs-pane-event-meta-${event.id}`} className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-400">{new Date(event.ts).toLocaleTimeString()}</span>
                    <span className="rounded bg-slate-700/80 px-1 py-0.5 uppercase">{event.level}</span>
                  </div>
                  <div id={`logs-pane-event-message-${event.id}`} className="mt-1 text-slate-100">
                    {event.message}
                  </div>
                  {attrsText && (
                    <pre
                      id={`logs-pane-event-attrs-${event.id}`}
                      className="mt-1 overflow-x-auto rounded bg-black/30 px-2 py-1 text-slate-300"
                    >
                      {attrsText}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
