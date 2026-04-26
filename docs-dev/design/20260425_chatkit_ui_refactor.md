# 2026-04-25: ChatKit UI Refactor

## Summary

The dropped-messages bug on `web.runme.dev` is a concrete symptom of a larger
design problem in the Codex ChatKit integration:

- ChatKit still owns part of the active-thread UI and emits thread-change events.
- `CodexConversationController` owns the real Codex thread lifecycle.
- `ChatKitPanel` currently tries to keep those two state machines synchronized.

That split is fragile. The immediate race around `onThreadChange({ threadId:
null })` was fixed, but the underlying design still allows ChatKit UI state to
clear or mutate Codex thread state at the wrong time.

This doc proposes a broader refactor:

- treat ChatKit as a transcript/composer surface for all harnesses,
- move remaining project/thread controls out of the ChatKit header,
- make the web app the single owner of project/thread/turn state across
  harnesses.

## Motivation

### User-visible bug

`web.runme.dev` could drop an in-flight Codex reply and reset ChatKit back to
the start screen even though the backend continued streaming assistant messages
for the same turn.

Observed symptom:

- the user prompt is accepted,
- ChatKit briefly shows the message and an empty assistant section,
- then the panel resets to the greeting screen,
- while backend logs continue to show valid deltas for the original thread.

### Root cause

The specific race was:

1. `CodexConversationController.ensureActiveThread()` sets `currentThreadId`.
2. React has not rerendered `ChatKitPanel` yet.
3. ChatKit emits `onThreadChange({ threadId: null })`.
4. The panel forwards that event back into the Codex adapter.
5. The adapter maps `null` to `controller.startNewChat()`.
6. Local UI state is cleared while Codex continues streaming on the original
   backend thread.

The narrow fix was to consult the controller's live snapshot inside
`onThreadChange`.

That fix is correct, but it does not remove the architectural problem:
ChatKit-owned thread UI can still push thread state changes back into the Codex
controller.

## Current Design

### Intended ownership

The Codex refactor design already says the browser-side controller should own:

- thread/turn lifecycle,
- current thread selection,
- history loading,
- interrupt handling,
- conversion from Codex notifications into ChatKit-compatible events.

That is the right model.

### Actual ownership today

For Codex harnesses, ownership is currently split.

`CodexConversationController` owns:

- selected project,
- `currentThreadId`,
- `currentTurnId`,
- `thread/start`,
- `thread/read`,
- `thread/resume`,
- `turn/start`,
- `turn/interrupt`,
- project-scoped history.

ChatKit still owns:

- its internal active-thread state,
- the ChatKit header title,
- the left header action used as the drawer toggle,
- the right header action used for new chat,
- `onThreadChange` events that are fed back into the controller.

The project/thread drawer contents are already app-owned React UI rendered by
`ChatKitPanel`, but the entry points for that UI still live in the ChatKit
header.

## Why ChatKit Feels Awkward Here

ChatKit is designed around a ChatKit-shaped backend contract. Even with the
custom integration path, it still expects a backend-like owner for:

- thread creation,
- thread selection,
- thread listing,
- item listing,
- streaming response events.

That model works well when the backend is the source of truth for threads.

The Codex integration is different:

- the browser owns project state,
- the browser owns the Codex controller,
- the browser translates between Codex lifecycle messages and ChatKit stream
  events,
- the browser is effectively emulating a ChatKit backend for a UI component.

Once we do that, ChatKit thread-management UI stops being a good authority for
Codex thread state. It becomes another state machine that has to be reconciled
with the real one.

## Proposed Design

### Principle

For `responses-direct`, `codex`, and `codex-wasm`, the web app should be the
only owner of:

- project selection,
- active thread selection,
- new conversation creation,
- history visibility,
- thread bootstrap timing.

ChatKit should only own:

- transcript rendering,
- streaming markdown rendering,
- composer,
- submit action.

### UI boundary

For all harnesses:

- remove project/thread controls from the ChatKit header,
- do not use the ChatKit header at all,
- render the entire chat header in app-owned React,
- keep history and thread selection in app-owned React,
- keep ChatKit below that header as the transcript/composer surface.

Concretely, the following controls should move out of ChatKit:

- the title area,
- the left menu/history button,
- the right compose/new-chat button,
- the model picker.

For Codex, the thread list itself is already app-owned. The main missing step
is to move the header entry points out of ChatKit so the full thread-management
surface has one owner.

For `responses-direct`, this means migrating away from ChatKit-native history
and thread controls so the same app-owned shell drives every harness.

### State flow

State flow should be one-way for every harness:

1. app-owned UI dispatches actions to the harness conversation controller
2. controller mutates project/thread/turn state
3. app synchronizes ChatKit to the selected thread when needed
4. ChatKit renders transcript/composer state
5. ChatKit submit requests are routed into the controller

The reverse flow should not exist for thread management.

In particular:

- `onThreadChange` should not be used as an authoritative source of Codex
  or responses thread changes,
- ChatKit `null` thread transitions should never be allowed to clear app-owned
  thread state,
- ChatKit header actions should not be the primary way the user changes thread
  state.

### Draft and new-thread state

The app-owned conversation controller should explicitly represent draft mode:

- `currentThreadId: string | null`
- `null` means there is no persisted active thread yet
- draft mode is valid and expected when the user first opens the chat panel
- draft mode is also valid immediately after `New chat`

Expected behavior:

1. On first mount:
   - if the controller has a real `currentThreadId`, mount ChatKit with
     `initialThread = currentThreadId`
   - otherwise mount ChatKit with `initialThread = null`
2. When the user selects an existing thread after mount:
   - app/controller sets `currentThreadId = threadId`
   - app calls `chatkit.setThreadId(threadId)`
   - ChatKit fetches thread state and rerenders the prior history
3. When the user clicks `New chat`:
   - app/controller sets `currentThreadId = null`
   - app calls `chatkit.setThreadId(null)`
   - ChatKit enters draft/new-thread mode
4. When the user submits while `currentThreadId === null`:
   - the controller creates a real thread lazily
   - the controller updates `currentThreadId`
   - the adapter emits the normal ChatKit create/send stream for that newly
     created thread

`setThreadId` is therefore the right primitive for post-mount thread switches,
including switching back to draft mode with `null`.

`initialThread` is only the mount-time hydration hook.

## Specific Recommendations

### 1. Make app UI the only header and thread-management UI for all harnesses

For `responses-direct`, `codex`, and `codex-wasm`:

- disable the ChatKit header,
- render a Runme-owned header above ChatKit,
- keep `New chat`, history/drawer toggle, and any harness-specific controls in
  that header.

### 2. Introduce one app-owned conversation controller interface

We should expose one app-owned conversation controller contract that every
harness implements.

That controller should own:

- active thread id,
- history loading,
- thread selection,
- new chat,
- send message,
- selected model,
- optional project selection when the harness supports it.

Codex can keep its richer controller underneath. `responses-direct` should gain
a lightweight controller so the app shell can treat all harnesses the same.

Minimal shared contract:

- `getSnapshot()`
- `subscribe(listener)`
- `refreshHistory()`
- `selectThread(threadId)`
- `newChat()`
- `sendMessage(input, options?)`
- `setSelectedModel(model)`
- optional `setSelectedProject(projectId)` for harnesses that support projects

The snapshot should include at least:

- `currentThreadId: string | null`
- `threads`
- `loadingHistory`
- `selectedModel`
- optional selected project metadata

### 3. Stop treating ChatKit thread changes as controller commands

For all harnesses:

- remove or sharply limit `onThreadChange`,
- do not map `threadId = null` to `controller.startNewChat()`,
- treat ChatKit thread changes as diagnostics at most, not state authority.

### 4. Make thread creation lazy

Do not create or resume a thread just because the panel mounted.

Preferred behavior:

- project switch loads history and clears active thread selection,
- `New chat` enters draft mode and does not create a persisted thread yet,
- first submit can also create a thread if none is selected.

This reduces bootstrap races and avoids creating threads the user never uses.

### 5. Keep a narrow ChatKit adapter boundary

The adapter should be responsible for:

- serving ChatKit thread/item fetches from controller state,
- mapping submit into `turn/start`,
- mapping Codex notifications into ChatKit stream events.

It should not be responsible for deciding when the app has entered "new chat"
mode due to ChatKit UI transitions.

Planned `HarnessChatKitAdapter` reduction:

- remove `historyEnabled`
- remove `onThreadSelected`
- remove `onNewConversation`
- remove any header/history ownership concerns

Keep only the ChatKit bridge behavior:

- `getThread(threadId)`
- `listItems(threadId)`
- `streamUserMessage(...)`
- optionally `listThreads()` only if ChatKit still requests it internally even
  when history UI is disabled

`listThreads()` should remain an adapter concern, not a requirement of the
shared conversation controller contract.

### 6. Controller and adapter interaction model

The interaction should be:

1. app-owned React UI calls the shared `ConversationController`
2. the controller owns active thread state, draft state, model selection, and
   history refresh
3. the app synchronizes ChatKit with `initialThread` on mount and
   `setThreadId(...)` after mount
4. ChatKit requests thread/items through the adapter
5. the adapter fulfills those requests by reading controller state
6. ChatKit submit flows through the adapter
7. the adapter delegates send/stream work to the controller

In other words:

- UI control plane: app -> controller
- ChatKit data plane: ChatKit -> adapter -> controller

### 7. Fate of `ensureActiveThread()`

The current `ensureActiveThread()` API should not survive as a public lifecycle
primitive.

It currently serves three roles:

- eager bootstrap thread creation,
- eager thread creation for `New chat`,
- send-time "make sure a thread exists" logic.

Under the new design:

- bootstrap should not create a thread,
- `New chat` should enter draft mode and should not create a thread,
- only the first submit in draft mode should create the persisted thread.

Recommendation:

- remove `ensureActiveThread()` as a public controller method,
- replace it with send-time internal logic such as
  `createThreadForDraftIfNeeded(...)`,
- keep thread creation behind the controller's send path.

## Design Questions To Resolve

### 1. Should every harness mount ChatKit with `header.enabled = false`?

Recommendation:

- yes.

Reason:

- the current ChatKit header only provides title and action buttons that the
  app can render directly,
- removing it gives the app one owner for all header and thread-management UI,
- it avoids ChatKit-specific control flow for drawer toggles and `New chat`,
- it simplifies harness consistency and testing.

### 2. Do we want lazy thread creation or eager bootstrap?

Recommendation:

- lazy thread creation.

Reason:

- it matches user intent better,
- avoids empty bootstrap-created threads,
- reduces timing races between controller state and ChatKit state.

### 3. Should ChatKit history remain disabled for all harnesses?

Recommendation:

- yes.

Reason:

- one app-owned history surface is simpler than mixing ChatKit-native history
  for one harness and app-owned history for another,
- Runme projects and Codex thread filtering are app-specific,
- consistent UI reduces harness-specific branching in `ChatKitPanel`.

### 3a. Does ChatKit still require `listThreads()` when history is disabled?

Recommendation:

- do not make `listThreads()` part of the shared controller contract,
- keep it on `HarnessChatKitAdapter` as an optional compatibility hook until
  request logs prove ChatKit no longer calls it when history is disabled.

Reason:

- the official docs clearly support disabling history UI, but they do not
  explicitly guarantee that no thread-list request path remains,
- the adapter is the correct place to absorb ChatKit-specific compatibility
  behavior,
- the app-owned shell should not depend on ChatKit thread-list semantics.

### 4. Where should the model picker live?

Recommendation:

- move it into app-owned UI and state.

Reason:

- the selected model should be visible to every harness through one consistent
  contract,
- app-owned state makes persistence straightforward,
- Codex and Responses can both consume the same selected model value,
- model choice should not depend on ChatKit-owned composer state.

### 5. What should happen when the user switches projects?

Recommendation:

- clear the active thread in controller state,
- refresh history for the new project,
- do not silently reuse a thread from another project,
- show an empty transcript until the user selects a thread or starts a new one.

### 6. Should ChatKit ever be allowed to create a thread implicitly?

Recommendation:

- only through submit flow when no active thread exists,
- not through unrelated ChatKit UI transitions,
- not through mount/bootstrap side effects.

This is equivalent to saying:

- draft mode is cheap and local,
- persisted thread creation is a result of message submission,
- `New chat` should not create empty threads.

### 7. Should `streamUserMessage()` stay on the adapter?

Recommendation:

- yes.

Reason:

- `streamUserMessage()` is the ChatKit-facing streaming bridge,
- it naturally belongs on `HarnessChatKitAdapter`,
- the adapter can translate ChatKit request semantics into controller send
  semantics,
- this keeps ChatKit-specific sink/event types out of the shared shell-facing
  controller contract.

The controller should still own the actual send lifecycle underneath. The
adapter should not invent its own thread lifecycle; it should delegate to the
controller for send/stream work.

## Migration Plan

### Phase 1: define a shared conversation-shell contract

- add an app-owned conversation controller interface used by `ChatKitPanel`,
- implement that contract for `responses-direct`,
- adapt the existing Codex controller to the same contract.
- reduce `HarnessChatKitAdapter` to the smaller ChatKit bridge surface.

### Phase 2: clarify ownership without changing visual layout much

- keep the existing race fix,
- stop using `onThreadChange` as an authoritative state update,
- make `null` ChatKit thread transitions diagnostic-only,
- move `New chat` and drawer-toggle actions out of the ChatKit header.

### Phase 3: move the entire header into app-owned React

- render a Runme header above the ChatKit surface for all harnesses,
- include:
  - title,
  - optional project title/select,
  - history button,
  - new chat button,
  - model picker.

### Phase 4: simplify controller/bootstrap behavior

- remove eager thread creation on runtime startup,
- load history only on startup/project switch,
- create threads lazily from the first submit in draft mode.
- remove `ensureActiveThread()` as a public lifecycle API.

### Phase 5: narrow the adapter

- keep ChatKit fetch emulation for transcript/composer support,
- stop using ChatKit events to drive app thread lifecycle,
- make controller -> ChatKit synchronization one-way.

## Expected Benefits

- removes a class of split-brain bugs between ChatKit and the controller,
- makes project/thread ownership explicit,
- reduces bootstrap complexity,
- makes Codex behavior easier to reason about in tests,
- makes `responses-direct` and Codex feel like the same product surface,
- reduces harness-specific branching in the chat UI,
- keeps the main ChatKit value: transcript rendering and streaming markdown UI.

## Non-Goals

- replacing ChatKit entirely in this iteration,
- rewriting transcript rendering,
- changing the Codex websocket protocol,
- changing project storage semantics.

## References

- [ChatKit OpenAIChatKit methods](https://openai.github.io/chatkit-js/api/openai/chatkit/interfaces/openaichatkit/#methods)
- [ChatKit methods guide](https://openai.github.io/chatkit-js/guides/methods)
- [ChatKit events guide](https://openai.github.io/chatkit-js/guides/events)
- [ChatKit options](https://openai.github.io/chatkit-js/api/openai/chatkit/type-aliases/chatkitoptions/)
- [Custom ChatKit integrations](https://developers.openai.com/api/docs/guides/custom-chatkit)

Relevant local code:

- [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx)
- [codexChatKitAdapter.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexChatKitAdapter.ts)
- [codexConversationController.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexConversationController.ts)
- [createChatKitFetchFromAdapter.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/createChatKitFetchFromAdapter.ts)
- [responsesDirectChatKitAdapter.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/responsesDirectChatKitAdapter.ts)

## Conclusion

The dropped-messages bug was not just an isolated race. It exposed that the
current integration lets ChatKit participate in thread management even when the
app already owns the real conversation model.

The right cleanup is to finish that architectural transition across all
harnesses:

- app-owned React UI for project/thread controls,
- controller-owned project/thread/turn state,
- ChatKit used narrowly as the transcript/composer surface.
