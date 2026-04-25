# 2026-04-25: Codex Dropped Messages In ChatKit

## Summary

`web.runme.dev` can drop an in-flight Codex reply and reset ChatKit back to the start screen even though the backend continues streaming assistant messages for the same turn.

The root cause is a race in the ChatKit panel's `onThreadChange` handler for Codex-backed harnesses:

- ChatKit can emit `onThreadChange({ threadId: null })` during thread/bootstrap transitions.
- The handler currently decides whether to ignore that null event from the render-time `codexConversation` hook snapshot.
- The Codex conversation controller can already have the real current thread id in memory before React rerenders with the updated hook snapshot.
- In that window, the stale closure sees `currentThreadId === null`, does not ignore the event, and calls `activeAdapter.onThreadSelected(null)`.
- The Codex adapter maps that to `controller.startNewChat()`, clearing the current thread locally while the backend is still streaming on the original thread.

Observed user symptom:

- assistant content briefly appears as empty or partial,
- then ChatKit resets to the greeting screen,
- while `/tmp/runme-agent.runner.log` continues to show `item/agentMessage/delta` notifications for the original turn.

## Reproduction

### Browser behavior

Using Chrome against `https://web.runme.dev` with the `local-codex (codex)` harness:

1. Start a fresh thread.
2. Submit:

```text
How would you configure a Jupyter kernel and then use it in runme; search the code and tell me what AppKernel code I should write
```

Observed:

- the prompt is accepted,
- ChatKit first shows the user message and an empty assistant section,
- then the panel resets to the start screen (`How can runme help you today?`).

### Backend evidence

The backend keeps streaming assistant output for the same turn:

- thread id: `019dc61a-e2fc-7b11-a70d-59d31db3dc43`
- turn id: `019dc628-f36b-7233-9f47-59e917d30369`

From `/tmp/runme-agent.runner.log`:

- [line 213](/tmp/runme-agent.runner.log:213): assistant delta begins at `2026-04-25 12:41:11 PDT`
- [line 373](/tmp/runme-agent.runner.log:373): assistant delta discussing Jupyter API mismatch
- [line 448](/tmp/runme-agent.runner.log:448): assistant delta with server config findings
- [line 494](/tmp/runme-agent.runner.log:494): assistant emits the long final AppKernel/Jupyter answer at `2026-04-25 12:43:12 PDT`

So this is not a backend drop. The UI loses thread state while Codex is still producing valid assistant messages.

## Code Path

Relevant files:

- [app/src/components/ChatKit/ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx)
- [app/src/lib/runtime/codexChatKitAdapter.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexChatKitAdapter.ts)
- [app/src/lib/runtime/codexConversationController.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexConversationController.ts)

Before the fix:

1. `CodexConversationController.ensureActiveThread()` sets `currentThreadId` synchronously when a thread is created or resumed.
2. `ChatKitPanel` still has an older render snapshot from `useCodexConversationSnapshot()`.
3. ChatKit emits `onThreadChange({ threadId: null })`.
4. `ChatKitPanel.onThreadChange` checks the stale hook snapshot instead of the controller's live state.
5. The null thread change is treated as real.
6. `activeAdapter.onThreadSelected(null)` runs.
7. `createCodexChatKitAdapter` maps that to `controller.startNewChat()`.
8. ChatKit resets locally while `turn/start` and proxy notifications continue for the original backend thread.

## Why The Simple Prompt Often Works

Short prompts like `write hello world in python` often complete without hitting the race because:

- fewer intermediate assistant updates are emitted,
- the thread/bootstrap transition is shorter,
- ChatKit has less time to emit a null thread change during the window between controller mutation and React rerender.

Longer prompts that trigger many early commentary deltas appear more likely to hit the race.

## Fix

Read the Codex controller's live snapshot inside `onThreadChange` instead of relying on the render-time `codexConversation` closure.

Updated file:

- [app/src/components/ChatKit/ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx)

Key change:

- import `getCodexConversationController`
- in `onThreadChange`, compute:
  - `liveCodexCurrentThreadId`
  - `liveCodexCurrentTurnId`
- use those live values for:
  - the null-thread ignore guard
  - associated diagnostics logging

This removes the stale-closure window because the callback now consults the controller's latest state at event time.

## Regression Test

Added test:

- [app/src/components/ChatKit/ChatKitPanel.test.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.test.tsx)

New case:

- render the panel with `codexConversationState.currentThreadId = null`
- then advance the mocked controller state to a real thread id *without rerendering*
- fire `onThreadChange({ threadId: null })`
- assert that:
  - `startNewChat()` is **not** called
  - the panel logs that it ignored the null thread change using the live controller thread id

This models the real race more accurately than the existing test, which only covered the post-rerender case.

## Verification

Passed:

```bash
pnpm test -- ChatKitPanel.test.tsx
```

This ran the full Vitest suite in the app workspace and the new regression passed.

Typecheck status:

```bash
pnpm typecheck
```

`typecheck` currently fails due many pre-existing unrelated errors in the repo. None were introduced by this fix; the failures span unrelated files such as `App.tsx`, `Actions.tsx`, `WorkspaceExplorer.tsx`, `NotebookContext.tsx`, and others.

## Follow-ups

1. Re-run the browser reproduction against a local build or deployed branch with this patch to confirm the start-screen reset is gone.
2. Consider adding an appLogger event when ChatKit emits `threadId = null` for Codex, including both the ChatKit thread id and live controller thread id, to make future races obvious.
3. If similar behavior appears again, inspect whether `initialThread` changes passed to `useChatKit(...)` cause their own reset paths. I do not currently have evidence that this is the primary bug here.
