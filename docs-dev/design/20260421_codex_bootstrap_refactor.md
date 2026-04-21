# 20260421 Codex Bootstrap Refactor

## Status

Draft proposal.

## Summary

Today some Codex runtime state and harness integration logic are initialized as
a side effect of React lifecycle in
[ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx).

That is the wrong ownership boundary for browser-driven evals and other
non-ChatKit entrypoints.

The proposed refactor is:

- keep long-lived Codex runtime objects as global singletons
- extract bootstrap/orchestration out of `ChatKitPanel`
- add a harness runtime layer that owns conversation state and ChatKit
  integration per harness
- standardize the harness-to-ChatKit boundary around a narrow adapter interface
  instead of generic `fetch` and UI-managed state

The goal is to move runtime initialization and harness-specific state handling
out of React effects and into explicit runtime services.

## Background

### Background: Harness Integration Is Not Standardized Yet

Today we support 4 harness types:

- Codex via proxy/runner the browser talks to a websocket proxy, and that proxy/runner can
  speak to a Codex app-server using the supported external integration path
- Codex wasm - the browser runs a local Codex app-server inside a dedicated
  module Web Worker that hosts the wasm runtime
- responses-direct  - the browser calls the OpenAI Responses API directly and
  performs ChatKit-to-Responses conversion locally

- responses via proxy - A proxy on the backend handles chatkit to responses conversion
  * We propose to get rid of this code path

All are routed through ChatKit, but they are not integrated in a
consistent way.

### Codex model
 
Both codex modes share the same high-level conversation model:

- `CodexConversationController` owns selected project, thread list, active
  thread, and active turn state
- `CodexAppServerClient` is the transport switch that routes requests and
  notifications to either `proxy` or `wasm`
- `ChatKitPanel` currently bootstraps the chosen transport and then syncs the
  resulting active thread back into ChatKit UI state

The important distinction is that the shared conversation state is the same,
but transport bootstrap and transport-local state are different.

#### Projects in Codex

Projects in Codex are collections of information (CWD, approval policy, etc...) that are used
to configure threads. A project is not an object in Codex's app-server. It is a collection
of configuration defined in Codex's desktop app that is used to configure threads.



### Responses Direct

Runme also has a responses-based harness path:

- `responses-direct`:

Historically there was also an implicit "responses via backend proxy" shape,
where ChatKit requests or state could be forwarded to a backend that performed
ChatKit-to-Responses conversion on behalf of the browser.


### Current State of Conversation Handling

Responses-direct tracks `previousResponseId` as conversation state. That state currently travels through the
generic `ChatKitStateValue` shape and is emitted back to ChatKit as
`aisre.chatkit.state` SSE events.

Codex uses a different conversation model:

- `CodexConversationController` owns thread list, current thread, current turn,
  and resume behavior
- `codexChatkitFetch.ts` still accepts `chatkit_state` on input because it is
  shaped like a ChatKit fetch shim
- `ChatKitPanel` maintains `syncedCodexStateRef` and explicitly ignores Codex
  state events instead of treating ChatKit state as the source of truth

That means `ChatKitStateValue` is acting as a generic cross-harness transport
for harness-specific state, but in practice it only really matches the needs of
the old responses-direct path.

### Current State of ChatKit Fetch Integration

`ChatKitPanel` currently builds one generic `authorizedFetch` wrapper and then
branches by harness:

- choose a base fetch implementation
- decide whether to inject Runme headers
- decide whether to inject `chatkit_state` into the request body
- intercept SSE to look for state updates

This is a legacy of earlier designs where ChatKit requests could be forwarded
to a backend that performed ChatKit-to-Responses conversion and therefore
needed ChatKit-owned state passed over the wire.

We do not need to preserve that design. For this refactor, we should be
explicit that:

- ChatKit-to-Responses conversion is handled in the browser
- harness-specific state should be owned by the harness runtime, not by generic
  ChatKit request plumbing
- generic fetch wrapping in `ChatKitPanel` should shrink substantially

### Current State of Tool Handling

Tool behavior is also split across layers in an inconsistent way:

- responses-direct relies on ChatKit `onClientTool` in `ChatKitPanel` for
  ExecuteCode and notebook tools
- Codex proxy uses `CodexToolBridge` plus `CodexExecuteApprovalManager`
- Codex wasm uses the worker bridge and installed wasm code executor

So today ChatKit UI code still knows too much about harness-specific tool
execution. That should be moved behind the harness boundary.


### Codex "Switchboard"

Today `CodexAppServerClient` is not a transport implementation by itself. It is
a small switchboard over two concrete clients:

- `CodexAppServerProxyClient`
- `CodexWasmAppServerClient`

That means callers talk to one singleton API, and that singleton forwards
requests, snapshots, and notifications to whichever transport is currently
selected through `useTransport("proxy" | "wasm")`.

This design is pragmatic, but a bit awkward:

- it hides transport choice behind mutable global state
- selecting a transport can disconnect another client underneath the caller
- transport-specific concerns leak into the shared facade API, for example
  authorization only matters for proxy mode and code-executor setup only matters
  for wasm mode

The main reason it exists is convenience. `CodexConversationController` and the
ChatKit integration only need to talk to one singleton app-server client,
instead of being parameterized over transport.

This refactor does not need to remove the switchboard. The immediate goal is to
make bootstrap explicit, not to redesign transport injection.

However, the switchboard is a reasonable future cleanup target. A cleaner shape
would be:

- define a small common app-server client interface
- have proxy and wasm each implement that interface directly
- let bootstrap choose one implementation and hand that to the rest of the
  runtime

That would reduce hidden mode switches and make the transport boundary easier to
reason about. It is a separate refactor from extracting bootstrap out of
`ChatKitPanel`.

### Shared Codex Runtime Initialization

Regardless of transport, the current startup path does this:

1. Choose the Runme project with
   `controller.setSelectedProject(...)`.
1. Select the transport on `CodexAppServerClient`.
1. Connect the chosen transport.
1. Call `controller.refreshHistory()` to load threads for the selected
   project's `cwd`.
1. Call `controller.ensureActiveThread()` to create or recover the active
   thread.
1. If ChatKit is mounted, push the resulting thread id back into ChatKit UI
   state.

This is shared runtime initialization, not just controller initialization. It
includes both:

- transport-independent controller work such as project selection, history
  loading, and active-thread setup
- transport setup that both modes need in some form before the controller can
  successfully make requests

That is why a single bootstrap helper makes sense even though the two transport
modes have different prerequisites.

### Mode 1: In-Browser `codex-wasm`

This mode runs the Codex app-server in the browser through
`CodexWasmAppServerClient`.

It uses a dedicated module Web Worker created by
`new Worker(new URL("./codexWasmWorker.ts", import.meta.url), { type: "module" })`,
not a service worker.

#### Initialization

The current `ChatKitPanel` bootstrap does the following for `codex-wasm`:

1. Build a notebook-aware `codeModeExecutor` from current app state.
1. Wrap it with `createCodexWasmCodeExecutor(...)`.
1. Install it with `getCodexAppServerClient().setCodeExecutor(...)`.
1. Switch the unified client to `useTransport("wasm")`.
1. Clear any proxy authorization resolver.
1. Call `connectWasm({ apiKey, sessionOptions })`.
1. Refresh history and ensure the active thread.

The notebook-aware executor matters because wasm mode can issue notebook and
code-execution requests that need access to the current Runme notebook model.

#### Codex State Tracking

Shared state still lives in `CodexConversationController`, but wasm mode also
owns transport-local state:

- `CodexWasmAppServerClient` connection state:
  `idle | connecting | open | closed | error`
- the dedicated Web Worker lifecycle and the wasm runtime it hosts
- the installed wasm code executor
- session configuration such as API key and browser session options
- the worker event journal exposed by `getEventJournal()`

### Mode 2: Proxy `codex`

This mode does not run the app-server in the browser. The browser connects to a
proxy websocket, and that external proxy/runner owns the server-side Codex
integration.

#### Initialization

The current `ChatKitPanel` bootstrap does the following for `codex`:

1. Switch the unified client to `useTransport("proxy")`.
1. Install an authorization resolver that produces a bearer token.
1. Resolve authorization eagerly during bootstrap.
1. Call `connectProxy(codexProxyWsUrl, authorization)`.
1. Configure the separate `CodexToolBridge` handler for notebook tool calls.
1. Connect the `CodexToolBridge` websocket with the same authorization.
1. Refresh history and ensure the active thread.

Unlike wasm mode, proxy mode does not install a browser-local wasm code
executor. Tool calls that need notebook-side behavior are routed through the
separate bridge.

#### State Tracking

Proxy mode shares the same controller state, but it has additional moving
pieces:

- `CodexAppServerProxyClient` websocket state:
  `idle | connecting | open | closed | error`
- authorization resolver state and token refresh behavior
- `CodexToolBridge` websocket state and registered request handler
- pending execute approvals tracked by `CodexExecuteApprovalManager`

That means proxy mode is really two coordinated channels:

- the app-server request/notification channel
- the notebook tool-call bridge channel

The bootstrap helper needs to make that coordination explicit, because today it
is spread across multiple `useEffect` blocks in `ChatKitPanel`.

## Problem: ChatKitPanel should not own Codex initialiation

The the initialization of Codex state (e.g.)

- `CodexConversationController` owns thread and turn state
- `CodexAppServerClient` owns transport selection
- `CodexWasmAppServerClient` owns the wasm worker-backed app-server client

is still partially embedded in `ChatKitPanel` `useEffect` blocks.

That means:

- the ChatKit UI implicitly owns Codex startup
- a Playwright/CDP eval driver cannot cleanly initialize the same runtime
  without mounting the UI and relying on its side effects
- the intended lifecycle is spread across component effects instead of one
  explicit runtime API

## Current State of useEffect

The relevant `ChatKitPanel` effects do the following:

1. Select the Codex project:
   [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:909)

2. Install the wasm code executor for `codex-wasm`:
   [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:920)
   backed by
   [codexWasmCodeExecutor.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmCodeExecutor.ts:31)

3. Select transport and connect the app-server client:
   [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:936)

4. Prime controller state with history + active thread:
   [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:968)

5. Push the bootstrapped thread id back into ChatKit UI state:
   [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:1011)

Separately, `ChatKitPanel` builds the `codeModeExecutor` from current notebook
state:
[ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx:482)


## Proposal: Keep Runtime Services Singleton

This refactor should use a singleton pattern for the long-lived
Codex runtime services and move bootstrap orchestration out of React.

### Singleton Runtime Services

These are app-wide, stateful runtime services and are good singleton
candidates:

- `CodexConversationController`
- `CodexAppServerClient`
- `CodexWasmAppServerClient`

Reasons:

- they model one active browser-local Codex runtime per app session
- they hold durable conversation or connection state
- the UI and eval driver should observe the same underlying runtime
- multiple independent instances would create ambiguous ownership of active
  thread, transport, and connection state

This is already the pattern used by the codebase through `get...()` accessors.

### Why Keep Them Singleton

These services should remain singleton because:

- they model one active browser-local Codex runtime per app session
- they hold long-lived conversation and connection state that should be shared
  across the UI and any eval driver
- they provide one consistent view of selected project, active thread, current
  turn, and transport state
- creating multiple independent instances would make ownership of active state
  ambiguous

In other words, singleton is the right fit for runtime identity and continuity.

## Proposal: Separate Harness Config From Runtime State

`app.harness` already provides a useful abstraction, but today it is only a
configuration registry.

`HarnessManager` currently owns:

- harness profiles keyed by name
- default harness selection
- persistence and cross-window synchronization

It does not own live Codex runtime state such as connected clients, bridge
connections, or conversation controller state.

This refactor should keep that split explicit instead of extending
`HarnessManager` into a mixed config-plus-runtime object.

## Proposal: Standardize Harness Runtime Integration

We should standardize around the idea that each harness owns:

- its own runtime bootstrap
- its own conversation state
- its own ChatKit protocol conversion
- its own tool-execution plumbing

ChatKit should not need to know whether a harness uses:

- `previousResponseId`
- Codex `threadId` plus `resume`
- a websocket bridge
- a worker bridge
- direct OpenAI Responses calls

### Proposed Harness Layers

Split the abstraction into three levels:

1. `HarnessProfile`
   persisted configuration such as name, adapter, and base URL
1. `HarnessRuntime`
   live runtime/session state for one configured harness
1. `HarnessChatKitAdapter`
   the single ChatKit-facing surface for both protocol operations and minimal
   UI-facing metadata

Conceptually:

```ts
type HarnessAdapter = "responses-direct" | "codex" | "codex-wasm";

type HarnessProfile = {
  name: string;
  adapter: HarnessAdapter;
  baseUrl: string;
};

type HarnessChatKitThreadRequest = {
  signal?: AbortSignal | null;
};

type HarnessChatKitMessageRequest = {
  threadId?: string;
  input: string;
  model?: string;
  signal?: AbortSignal | null;
};

type HarnessChatKitToolResultRequest = {
  threadId: string;
  callId: string;
  output: unknown;
  signal?: AbortSignal | null;
};

type HarnessChatKitEventSink = {
  emit(event: ChatKitEvent): void;
};

interface HarnessChatKitAdapter {
  initialThreadId?: string;
  historyEnabled: boolean;
  onThreadSelected?: (threadId: string | null) => Promise<void>;
  onNewConversation?: () => Promise<string | null>;
  listThreads(
    request?: HarnessChatKitThreadRequest,
  ): Promise<ChatKitThreadSummary[]>;
  getThread(
    threadId: string,
    request?: HarnessChatKitThreadRequest,
  ): Promise<ChatKitThreadDetail>;
  listItems(
    threadId: string,
    request?: HarnessChatKitThreadRequest,
  ): Promise<ChatKitItem[]>;
  streamUserMessage(
    request: HarnessChatKitMessageRequest,
    sink: HarnessChatKitEventSink,
  ): Promise<void>;
  submitToolResult(
    request: HarnessChatKitToolResultRequest,
    sink: HarnessChatKitEventSink,
  ): Promise<void>;
}

interface HarnessRuntime {
  readonly profile: HarnessProfile;
  start(): Promise<void>;
  stop(): void;
  createChatKitAdapter(): HarnessChatKitAdapter;
}
```

The important point is that `HarnessRuntime` owns harness-specific conversation
state internally. `ChatKitPanel` should not read or write `previousResponseId`,
`chatkit_state`, or other harness-private fields.

For `HarnessRuntime`:

- `profile`
  gives callers stable identity for the runtime they are using and lets the
  runtime report which harness config it was created from
- `start()`
  exists because some harnesses need explicit async bootstrap before they can
  serve ChatKit operations, for example websocket connection, wasm worker
  startup, history refresh, or active-thread creation
- `stop()`
  exists because these runtimes hold live resources that must be cleaned up,
  such as websocket connections, worker instances, bridge handlers, and pending
  approvals
- `createChatKitAdapter()`
  exists so the runtime can expose only the UI-facing capabilities ChatKit
  needs, without exposing the runtime's internal controller/client objects

For `HarnessChatKitAdapter`:

- `initialThreadId`
  exists because ChatKit wants to know which thread to show first, but that
  choice should come from the harness runtime rather than from React-owned
  continuity state
- `historyEnabled`
  exists because not every harness necessarily supports or wants ChatKit's
  thread-history UX in the same way
- `onThreadSelected`
  exists because thread selection is a runtime concern for some harnesses, such
  as Codex where selecting a thread updates controller state and resume behavior
- `onNewConversation`
  exists because starting a new conversation may require harness-specific logic
  such as resetting runtime continuity state, creating a fresh thread, or
  returning a new active thread id
- `listThreads`, `getThread`, and `listItems`
  exist because ChatKit needs read operations for history and thread display,
  and those should be expressed directly instead of encoded into fake HTTP
  requests
- `streamUserMessage`
  exists because sending a user message is the main streaming operation and it
  naturally maps to an event sink rather than a `fetch` abstraction
- `submitToolResult`
  exists because tool-result continuation is a distinct harness operation and
  should not be hidden inside generic UI callbacks or ad hoc request parsing

The overall rule is: each member should correspond to a real responsibility the
harness runtime already owns today, while removing transport and continuity
details from `ChatKitPanel`.


### `fetch` is a thin wrapper

`fetch` should remain only as a thin ChatKit SDK
compatibility wrapper.

The implementation should live in a shared helper, for example:

- `app/src/lib/runtime/createChatKitFetchFromAdapter.ts`

Its job is:

1. parse the incoming ChatKit SDK request body
1. map the request to one `HarnessChatKitAdapter` method
1. serialize the result back into either:
   - JSON for non-streaming read operations
   - `text/event-stream` for streaming operations

That wrapper should not:

- inject `chatkit_state`
- keep `previousResponseId`
- mutate harness continuity state
- implement harness-specific tool logic
- implement transport-specific auth/bootstrap logic

Those responsibilities stay inside the harness runtime.

Conceptually:

```ts
function createChatKitFetchFromAdapter(
  adapter: HarnessChatKitAdapter,
): typeof fetch {
  return async (input, init) => {
    const request = await parseChatKitRequest(input, init);

    switch (request.type) {
      case "threads.list":
        return jsonResponse({
          data: await adapter.listThreads({
            signal: init?.signal ?? null,
          }),
          has_more: false,
        });

      case "threads.get":
      case "threads.get_by_id":
        return jsonResponse(
          await adapter.getThread(request.threadId, {
            signal: init?.signal ?? null,
          }),
        );

      case "items.list":
      case "messages.list":
        return jsonResponse({
          data: await adapter.listItems(request.threadId, {
            signal: init?.signal ?? null,
          }),
          has_more: false,
        });

      case "threads.create":
      case "threads.add_user_message":
        return buildSseResponse((sink) =>
          adapter.streamUserMessage(
            {
              threadId: request.threadId,
              input: request.input,
              model: request.model,
              signal: init?.signal ?? null,
            },
            sink,
          ),
        );

      case "threads.add_client_tool_output":
        return buildSseResponse((sink) =>
          adapter.submitToolResult(
            {
              threadId: request.threadId,
              callId: request.callId,
              output: request.output,
              signal: init?.signal ?? null,
            },
            sink,
          ),
        );
    }
  };
}
```

So `fetch` is still present, but only as a serializer/deserializer shim for the
ChatKit SDK. The harness boundary itself remains operation-shaped, not
transport-shaped.


### Harness-Owned Conversation State

Each harness should manage its own conversation state privately:

- responses-direct can keep `previousResponseId` in its runtime/thread store
- Codex can keep thread/turn/resume state in `CodexConversationController`
- future harnesses can use different state models without changing ChatKit

If we need a common term, "conversation state" should mean an opaque
harness-owned runtime concept, not a generic UI-managed protobuf shape.

This means ChatKit should only deal in the pieces it actually needs:

- a narrow adapter for thread/message/tool operations
- an initial thread id, if any
- thread selection callbacks

It should not be the primary store for harness continuity state.

### Can We Remove `ChatKitState`?

Yes, that should be the target architecture.

Today `ChatKitState` still exists in several places:

- `CellContext` stores `threadId` and `previousResponseId`
- `ChatKitPanel` injects `chatkit_state` into request bodies
- responses-direct emits `aisre.chatkit.state` SSE events
- Codex fetch/controller code still accepts `ChatKitStateValue`

Those uses are mostly legacy compatibility from the older design where ChatKit
or a backend adapter was expected to carry harness continuity state.

The cleaner end state is:

- harness runtimes own continuity state privately
- ChatKit receives only a harness-provided binding
- ChatKit no longer sends `chatkit_state`
- harness adapters no longer emit `aisre.chatkit.state`

So the answer is "yes, but not in one step." The practical migration is:

1. stop making `ChatKitPanel` read and write `ChatKitState`
1. move continuity state fully into harness runtimes
1. update harness ChatKit adapters so they do not require `chatkit_state`
1. remove `aisre.chatkit.state` emission
1. delete `ChatKitStateValue`, `ChatkitStateSchema`, and the remaining
   `CellContext` storage once the adapters no longer depend on them

This refactor should explicitly move toward removing `ChatKitState`, not
preserving it as a long-term abstraction.

### Harness-Owned ChatKit Conversion

Each harness should provide its own ChatKit protocol adapter.

That adapter can:

- parse ChatKit request types such as `threads.list`, `threads.get`, and
  `threads.add_user_message`
- translate them into harness runtime calls
- emit ChatKit-compatible SSE events back to the UI

This keeps ChatKit protocol conversion close to the runtime that actually owns
conversation state.

For responses-direct this means keeping ChatKit-to-Responses conversion in the
browser, not on a backend.

For Codex this means the ChatKit adapter should delegate to
`CodexConversationController` and the selected Codex transport, not to generic
UI state.

### Harness-Owned Tool Execution

Tool handling should also move behind the harness boundary.

The intended ownership becomes:

- responses-direct harness runtime executes or routes ExecuteCode/notebook tools
- Codex proxy harness runtime owns bridge setup and execute approval handling
- Codex wasm harness runtime owns the wasm code executor bridge

`ChatKitPanel` should no longer decode harness-specific tool payloads itself.
If ChatKit still requires an `onClientTool` callback, the UI wrapper should
delegate that callback to the active harness adapter rather than implementing
tool semantics in `ChatKitPanel`.

### Immediate Cleanup Targets

Based on the current code, this refactor should aim to:

1. remove generic `includeChatkitState` request mutation from
   `useAuthorizedFetch`
1. remove harness-specific `previousResponseId` handling from `ChatKitPanel`
1. stop using ChatKit state as a generic carrier for harness continuity data
1. move `onClientTool` behavior out of `ChatKitPanel` and into harness runtimes
1. move auth/header behavior behind the harness boundary where possible
1. keep browser-local ChatKit-to-Responses conversion as the only supported
   responses-direct conversion path

### Open Question We Can Punt On

There is still a product question around thread restoration:

- when ChatKit opens for a harness, which thread should it show first?

That question is real, but it is separable from the runtime refactor. For now
we can preserve current behavior:

- runtime starts
- runtime loads history if supported
- runtime provides an initial thread id if it already has one
- otherwise runtime ensures or creates an active conversation as needed

## Proposed Refactor

Introduce a small runtime orchestrator, for example:

- `app/src/lib/runtime/codexHarnessBootstrap.ts`

This module should export an app-level helper such as:

```ts
type CodexHarnessMode = "codex" | "codex-wasm";

type StartCodexHarnessOptions = {
  mode: CodexHarnessMode;
  projectId?: string;
  proxyUrl?: string;
  resolveAuthorization?: () => Promise<string>;
  wasmApiKey?: string;
  wasmSessionOptions?: BrowserSessionOptions;
  wasmCodeExecutor?: CodexWasmCodeExecutor | null;
};

type StartCodexHarnessResult = {
  threadId: string;
  previousResponseId?: string | null;
};

interface CodexHarnessBootstrap {
  start(options: StartCodexHarnessOptions): Promise<StartCodexHarnessResult>;
  stop(): void;
}
```

### Responsibilities of the bootstrap helper

`start(...)` should do exactly the work now embedded in `ChatKitPanel`:

- optionally set selected project on `CodexConversationController`
- configure code executor when mode is `codex-wasm`
- select app-server transport
- connect proxy or wasm client
- connect the tool bridge when mode is `codex`
- refresh history
- ensure an active thread
- return the bootstrapped thread info

`stop()` should:

- clear authorization resolver
- clear wasm code executor
- disconnect the app-server client

## Thin Prompt Helper

Add a small helper around `streamUserMessage(...)`, for example:

- `runCodexPrompt(...)`

Shape:

```ts
type RunCodexPromptResult = {
  nextState: ChatKitStateValue;
  events: ChatKitStreamEvent[];
};
```

This helper should:

- accept prompt + optional model override + incoming ChatKit state
- collect events emitted by `CodexConversationController.streamUserMessage(...)`
- return the collected events and next state

This is not a new runtime layer. It is just a convenience adapter for
non-ChatKit callers.

## Why This Is Better

- startup becomes explicit instead of hidden in component mount/update timing
- the same runtime can be used by ChatKit UI and eval drivers
- the lifecycle is easier to test directly
- failure and cleanup paths become easier to reason about
- React goes back to consuming runtime state instead of owning runtime startup

## Non-Goals

- Do not remove the existing singleton runtime services.
- Do not duplicate prompt execution logic outside
  `CodexConversationController`.
- Do not redesign ChatKit itself.
- Do not introduce multiple concurrent browser-local Codex runtimes in this
  refactor.

## Decision

Use singleton services for the long-lived Codex runtime objects, but move the
bootstrap sequence out of `ChatKitPanel` into an explicit runtime orchestrator.

That gives us the right ownership split:

- singleton state for runtime identity and continuity
- explicit APIs for startup, shutdown, and prompt execution
- React as a consumer of runtime state rather than the owner of runtime side
  effects
