export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  id: string;
  ts: string;
  level: LogLevel;
  message: string;
  attrs?: Record<string, unknown>;
}

export interface LogQuery {
  level?: LogLevel;
  minLevel?: LogLevel;
  limit?: number;
}

export interface LogOptions {
  attrs?: Record<string, unknown>;
}

const MAX_EVENTS = 500;
const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Returns true when a log level should be included by the current filter.
 * Keeping this as a helper makes list() easier to read and test.
 */
function matchesLevel(eventLevel: LogLevel, query: LogQuery): boolean {
  if (query.level && eventLevel !== query.level) {
    return false;
  }

  if (query.minLevel && levelOrder[eventLevel] < levelOrder[query.minLevel]) {
    return false;
  }

  return true;
}

function createLogID(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") {
      return randomUUID.call(globalThis.crypto);
    }
  } catch {
    // Logging must never throw due to UUID generation in constrained runtimes.
  }

  return `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface LoggingRuntimeStore {
  log(level: LogLevel, message: string, options?: LogOptions): LogEvent;
  list(query?: LogQuery): LogEvent[];
  subscribe(listener: () => void): () => void;
}

/**
 * LoggingRuntime keeps a bounded in-memory event list that both feature code
 * and React UI components can access through one app-scoped singleton.
 */
class LoggingRuntime implements LoggingRuntimeStore {
  private events: LogEvent[] = [];

  private listeners = new Set<() => void>();

  /**
   * log creates a normalized LogEvent and stores it in a ring buffer.
   * The same event is then visible to any subscribed UI panel.
   */
  log(level: LogLevel, message: string, options: LogOptions = {}): LogEvent {
    const event: LogEvent = {
      id: createLogID(),
      ts: new Date().toISOString(),
      level,
      message,
      attrs: options.attrs,
    };

    this.events.unshift(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS;
    }

    this.listeners.forEach((listener) => listener());
    return event;
  }

  list(query: LogQuery = {}): LogEvent[] {
    const { limit } = query;
    const filtered = this.events.filter((event) => matchesLevel(event.level, query));

    if (!limit || limit <= 0) {
      return filtered.map((event) => ({ ...event }));
    }

    return filtered.slice(0, limit).map((event) => ({ ...event }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function createLoggingRuntime(): LoggingRuntimeStore {
  return new LoggingRuntime();
}

export const loggingRuntime = createLoggingRuntime();

/**
 * appLogger is a tiny convenience API that keeps call sites terse while
 * preserving the same structured event contract for all producers.
 */
export const appLogger = {
  debug: (message: string, options?: LogOptions) =>
    loggingRuntime.log("debug", message, options),
  info: (message: string, options?: LogOptions) =>
    loggingRuntime.log("info", message, options),
  warn: (message: string, options?: LogOptions) =>
    loggingRuntime.log("warn", message, options),
  error: (message: string, options?: LogOptions) =>
    loggingRuntime.log("error", message, options),
};
