# Logging Architecture (Draft)

## Status

Draft for design iteration.

## Problem Statement

The app currently handles many failures in-place (for example, Google Drive auth and
runner connectivity), but there is no single structured logging path that:

1. Surfaces actionable issues to users.
2. Makes those same issues accessible to AI assistance.
3. Supports multiple storage and transport sinks.

We need a logging architecture that lets feature code emit structured events once,
then fan those events out to UI, persistence, and AI consumers.

## Standard API Baseline (TypeScript vs Go)

TypeScript/JavaScript does **not** provide a single standard structured logging API
equivalent to Go's `log/slog` in the language/runtime itself. Browser `console.*`
exists, but it is transport-oriented and not a typed, queryable application logging
contract.

For this app we should define a **Go `slog`-inspired internal API** so usage feels
familiar and consistent:

- level-based methods (`info`, `warn`, `error`)
- structured key-value attributes (`attrs`)
- contextual enrichment (`with(...)` / child logger)
- handler/sink fan-out behind a shared dispatcher
- typed record shape usable by UI and AI consumers

## Primary Requirements

### Functional Requirements

1. **Surface errors to the user**
   - Important failures should be visible in product UI (initially internal plumbing,
     later via a dedicated logs/activity panel).
2. **Make errors accessible to AI**
   - AI features should be able to consume recent logs to help users diagnose issues.
3. **Structured logging API**
   - Callers can emit logs with a `level` (`debug`, `info`, `warn`, `error`) and structured
     metadata, including stable `code` and `scope` fields.
4. **Multiple sinks**
   - Same log event can be routed to one or more sinks:
     - in-memory sink for live UI
     - optional persistence sink (for example IndexedDB)
     - AI sink for assistant context
5. **Low-friction instrumentation**
   - Feature code (e.g. Drive auth, runner websocket) should log via a simple API.

### Non-Functional Requirements

- **Typed payloads**: favor TypeScript-first schema and compile-time checks.
- **Privacy-aware defaults**: avoid accidental logging of secrets (tokens, auth headers,
  user document content).
- **Bounded resource usage**: ring-buffer or capped storage to prevent memory growth.
- **Resilience**: logging should never crash the caller path.

## Design Goals and Non-Goals

### Goals

- One internal event format used by all emitters.
- One dispatcher pipeline with pluggable sinks.
- Predictable log taxonomy so logs are queryable/filterable.
- Compatible with existing React context patterns.

### Non-Goals (for initial phase)

- External remote log shipping.
- Full observability stack (traces/metrics).
- Final end-user UI design (we only define interfaces needed by future UI).

## Proposed Architecture

```mermaid
flowchart LR
    A[Feature code\nDrive auth / Runner / Storage] --> B[Logger API]
    B --> C[Dispatcher]
    C --> D[In-memory sink]
    C --> E[IndexedDB sink optional]
    C --> F[AI context sink]
    D --> G[UI consumer\n(toast/activity panel)]
    F --> H[AI chat context provider]
```

### 1) Logger API (producer-facing, Go `slog`-style)

Feature modules import a shared logger service and emit structured records.

Conceptual API:

```ts
type LogLevel = "debug" | "info" | "warn" | "error";

type LogAttrValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | LogAttrValue[]
  | { [k: string]: LogAttrValue };

interface LogAttr {
  key: string;
  value: LogAttrValue;
}

interface Logger {
  debug(msg: string, ...attrs: LogAttr[]): void;
  info(msg: string, ...attrs: LogAttr[]): void;
  warn(msg: string, ...attrs: LogAttr[]): void;
  error(msg: string, err?: unknown, ...attrs: LogAttr[]): void;

  // Like slog.With(...): bind context to derived logger.
  with(...attrs: LogAttr[]): Logger;
}
```

Recommended conventions:

- Use `code` and `scope` as first-class attrs on emitted records.
- Prefer stable `code` values for machine handling and UI mapping.
- `error(...)` accepts `err` separately so stack/name extraction is consistent.

Each call produces a normalized `LogEvent` object.



### 1a) Field population rules (`code`, `scope`, visibility hints)

To answer implementation details explicitly:

- **`code` population**
  - `code` is required at emit time via attrs (for example `attr("code", "DRIVE_AUTH_TOKEN_FAILED")`).
  - The dispatcher validates `code` is a non-empty string and falls back to
    `UNCLASSIFIED_ERROR` only for defensive compatibility in early rollout.
  - Over time, codes should come from a shared catalog (const enum/object) to avoid drift.
- **`scope` population**
  - `scope` should usually be attached once via `logger.with(attr("scope", "storage.drive.auth"))`
    in module setup, then inherited by child loggers.
  - If an event omits scope, dispatcher sets `scope = "app.unknown"` and marks it for
    follow-up cleanup in development diagnostics.
- **`userVisible` / `aiVisible` population**
  - Callers may override either hint explicitly as attrs (`userVisible`, `aiVisible`).
  - If absent, dispatcher applies policy defaults by level/code:
    - `error` => `userVisible: true`, `aiVisible: true`
    - `warn` => `userVisible: false`, `aiVisible: true` for selected codes
    - `info`/`debug` => `userVisible: false`, `aiVisible: false`
  - A small policy table (level + optional code overrides) should own these defaults so
    behavior is consistent across all emitters and sinks.

### 2) Normalized Log Event Schema

```ts
type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEvent {
  id: string;                // uuid
  ts: string;                // ISO timestamp
  level: LogLevel;
  code: string;              // stable machine code, e.g. DRIVE_AUTH_TOKEN_FAILED
  message: string;           // human-readable summary
  scope: string;             // subsystem, e.g. "storage.drive", "runner.ws"
  attrs?: Record<string, unknown>; // sanitized structured attributes
  cause?: {
    name?: string;
    message?: string;
    stack?: string;
  };
  userVisible?: boolean;     // hint for UI surfacing
  aiVisible?: boolean;       // hint for AI context inclusion
}
```

Notes:

- `code` is required and stable to support analytics and AI heuristics.
- `attrs` must be sanitized by policy before dispatch.
- `userVisible` and `aiVisible` allow selective routing without custom sink logic in
  every caller.

### 3) Dispatcher

The dispatcher is responsible for:

- validating/normalizing events
- applying redaction policy
- forwarding to all registered sinks
- isolating sink failures (sink error should not break event emission)

Suggested sink contract:

```ts
interface LogSink {
  id: string;
  accepts(event: LogEvent): boolean;
  write(event: LogEvent): Promise<void> | void;
}
```

### 3a) Query API for UI/AI consumers

To enable a logs UI component, define a read interface backed initially by the
in-memory sink.

```ts
interface LogQuery {
  // If set, include only events with level >= minLevel (severity ordering).
  minLevel?: LogLevel;
  // Optional exact match filter.
  level?: LogLevel;
  scope?: string;
  code?: string;
  limit?: number;
}

interface LogStore {
  list(query?: LogQuery): LogEvent[];
  subscribe(cb: (event: LogEvent) => void): () => void;
}
```

Minimum required behavior for this milestone:

- `list({ minLevel: "error" })` should power an errors-focused UI panel.
- `list({ level: "warn" })` should support exact-level views when needed.
- Results are returned newest-first and bounded by sink retention policy.



### 3b) Access pattern for application code (singleton + React hook)

Application code needs a concrete way to access both emit and query APIs.
Recommended Phase 1 approach:

```ts
interface LoggingRuntime {
  logger: Logger;
  store: LogStore;
  registerSink(sink: LogSink): () => void;
}

// app-scoped singleton created during app bootstrap
export const loggingRuntime: LoggingRuntime = createLoggingRuntime();
```

Access options:

1. **Non-React modules** (storage, runner, services) import `loggingRuntime.logger`
   directly (or module-scoped child loggers).
2. **React UI** consumes a `LoggingProvider` + `useLogs(query)` hook backed by
   `loggingRuntime.store.subscribe(...)` and `list(query)`.
3. **Tests** can replace runtime with an in-memory test runtime for deterministic
   assertions.

This gives a practical global singleton for now, while keeping a clean seam to move to
DI/context-only wiring later if needed.

### 4) Sinks

#### In-memory sink (Phase 1)

- Keeps a bounded ring buffer (for example latest 500 events).
- Exposes subscription hooks for React UI.
- Enables immediate user-facing error surfacing.

#### IndexedDB sink (Phase 2)

- Persists selected events for troubleshooting across reloads.
- Could use Dexie in line with existing storage patterns.
- Retention policy: cap by count and/or age.

#### AI sink (Phase 1)

- Maintains AI-safe subset of recent events.
- Provides query helpers:
  - `getRecentErrors(limit)`
  - `getEventsByScope(scope, limit)`
- Integrates with AI context assembly for chat sessions.

## Error Surfacing Strategy

### User-facing

Initial policy proposal:

- `error` level defaults to `userVisible = true` unless explicitly disabled.
- `warn` level defaults to non-blocking visibility (activity feed, not toast).
- UI can map `code` to friendlier remediation copy.

### AI-facing

Initial policy proposal:

- `error` and selected `warn` events default `aiVisible = true`.
- AI context includes recent high-severity events with:
  - `code`, `message`, `scope`, timestamp
  - redacted context fields
  - optional remediation hints map by `code`

## Redaction and Data Safety

Define a centralized sanitizer before sink dispatch:

- Redact known sensitive keys (`token`, `access_token`, `authorization`, `cookie`,
  `apiKey`, etc.).
- Truncate oversized string payloads.
- Optionally whitelist per-scope safe fields.

Sanitization must run once in dispatcher so all sinks receive safe-by-default events.

## Instrumentation Examples

### Example A: Google Drive auth token failure

- `scope`: `storage.drive.auth`
- `code`: `DRIVE_AUTH_TOKEN_FAILED`
- `level`: `error`
- `attrs`:
  - `interactive`: boolean
  - `retryable`: boolean
  - `gapiLoaded`: boolean

### Example B: Runner connection failure

- `scope`: `runner.ws`
- `code`: `RUNNER_CONNECT_FAILED`
- `level`: `error`
- `attrs`:
  - `url`: redacted endpoint metadata
  - `attempt`: number
  - `backoffMs`: number

## Rollout Plan

### Phase 1 (Foundational)

- Add shared logger, event schema, dispatcher, in-memory sink, AI sink interface.
- Instrument high-value failure paths:
  - Drive auth/token flow
  - runner connect/disconnect flow
- Expose internal hook/API for UI consumption.

### Phase 2 (Productization)

- Add IndexedDB sink and retention policy.
- Add initial logs/activity UI surface.
- Add AI prompt-context integration using `aiVisible` events.

### Phase 3 (Maturity)

- Add event-code catalog and remediation metadata.
- Add sampling/rate-limit controls for noisy scopes.
- Consider optional remote diagnostics export.

## Open Questions

1. Where should logger live (`app/src/lib/logging` vs context-driven package)?
2. What is the right default retention size for memory and IndexedDB?
3. Should AI get raw sanitized events or a summarized digest?
4. Do we need per-scope log-level overrides at runtime?
5. How should user-facing notifications deduplicate repeated errors?

## Suggested Next Step

Create an RFC follow-up with:

- concrete TypeScript interfaces
- file layout proposal
- first instrumentation PR scope (Drive auth + runner connection)
- minimal UI debug panel for development verification
