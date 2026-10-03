# Agents API monitors in notebooks

Date: 2026-10-03

## Decision

An AppKernel JavaScript cell can render an interactive agent monitor:

```js
agents.monitor(session_id, { pageSize: 50 })
```

The cell has Edit and Render modes. Edit shows the source; Render shows the monitor. Running the cell creates the widget and returns immediately. The cell execution finishing does not mean the agent turn finished. Editing does not execute code or cancel the agent. Rerunning replaces the old monitor.

Keep agent creation, sending messages, and cancellation in explicit code cells. The first version is a read-only monitor; it never submits a message, approves a request, or cancels a turn as a side effect of reconnecting. A composer and approval forms can follow once their semantics are designed.

## Current state

The supplied Python cell retrieves the session and iterates all session items in ascending order. It prints assistant text and refusals. It drops user messages and tool calls, prints Markdown literally, and requires rerunning to refresh. Its API key is read on a local runner, which is a different execution environment from browser JavaScript.

AppKernel currently saves stdout/stderr as cell output. Add a typed output MIME for the monitor, rendered by React; do not execute generated HTML or persist callbacks.

## Events versus items

Items are durable messages and tool calls. Events describe changes, including text deltas, item creation, session state, and turn completion. The timeline is an item view. A bounded Activity disclosure shows recent events for diagnosis; it is not a second conversation timeline.

Use item IDs to reconcile persisted and streamed content. Append output-text deltas to their content part; replace the part on output_text.done. Done can arrive without any deltas. Final saved items take precedence over buffered deltas during recovery. Event IDs deduplicate delivery. Preserve unknown item types as expandable JSON.

Session status, root-turn status, and connection status are separate. Idle is not success. A closed stream is not success. Subagent turn completion does not complete the root turn. A completed turn does not guarantee that every tool succeeded. Required actions are displayed from the retrieved session without acting on them.

## Cell UX

1. Write a JS cell and select AppKernel.
2. Open Key Vault in the left navigation, create/unlock the vault, and add a named key. In browser JS, call agents.setKey(keyvault.getKey("openai-api")), then agents.monitor(session_id).
3. The editor collapses into Render mode. A toolbar retains Edit, Render, Run, and normal cell actions.
4. Edit reveals source while keeping the monitor mounted but hidden. Returning to Render does not rerun code. After source changes, label the existing output as coming from an earlier execution until Run is pressed.
5. Clearing output, rerunning, deleting the cell, or closing the notebook releases the widget's stream. Pause monitoring stops observation only. Resume reconnects and reloads saved history.
6. Saved outputs contain only a versioned descriptor (widget ID, session ID, page size). Reopening a notebook shows a disconnected monitor and requires Connect; it does not run notebook code or reuse saved credentials.

## Monitor layout

```text
Agent session  sess_…                         [Pause monitoring]
Session: in progress · Root turn: in progress · Connection: live
[Older] [Newer] [Latest]                       Latest 50 items
----------------------------------------------------------------
You                         completed
  Check the deployment.
Assistant · commentary      completed
  I’ll inspect the rollout.
▸ shell_call                completed
Assistant · final answer    completed
  Markdown text, lists, fenced code, tables, and links
----------------------------------------------------------------
▸ Required actions
▸ Activity (most recent 100 events)
```

Use chronological order within each page. Messages show role, phase, and status. Render text with react-markdown and GFM, with raw HTML disabled. Tools and unfamiliar content parts retain expandable structured details. Remote images display an attachment placeholder rather than automatic network loads. No Markdown command executes. Buttons have accessible labels; only compact status changes use a live region.

## Pagination and live updates

Default page size is 50, configurable from 1 to 100. Fetch items with order=desc and reverse that page for display. Older requests use the server's last_id as after, retaining the same descending order. Never derive a cursor from a filtered message list. Preserve null-ID legacy messages with page-local keys and stop with an explicit diagnostic if has_more is true without a usable cursor.

Keep one visible history page and one bounded live window. Older replaces the visible page instead of growing the DOM. Newer uses the recorded cursor stack; Latest returns to the live window. While reading history, events update the live window and a new-activity indicator without moving the user's page or scroll. A fixed-height scroll area keeps the notebook stable. Auto-follow applies only at the live bottom; scrolling up disables following until the user returns to the bottom or selects Latest.

## State and recovery

A domain controller owns immutable snapshots and subscribe/getSnapshot methods. React observes it with useSyncExternalStore. UI buttons and agents runtime commands call the same controller.

On connect or reconnect: open the SSE stream and buffer events, retrieve session/items/latest root turn, install the snapshot, then apply buffered events. Ignore buffered deltas for already-final items. Bound the hydration buffer; overflow must report a recoverable error rather than silently drop data. A failed session stops reconnection. Unexpected EOF or network failure shows Disconnected with an explicit Reconnect control, preserving the last visible data. Reconnect fetches authoritative saved state; it never resends work. Request generations and AbortController prevent late responses from reviving a disposed monitor.

The latest root-turn endpoint is consulted independently of item history. Missing turn history is shown as unknown, never inferred from a final-answer message. Root-turn events update the status without letting a child turn replace it.

## Runtime and transport

```ts
agents.setKey(keyvault.getKey('openai-api'))
const widget = agents.monitor(session_id, { pageSize: 50 })
agents.get(widget.id)        // JSON snapshot
agents.pause(widget.id)
await agents.resume(widget.id)
await agents.older(widget.id)
await agents.newer(widget.id)
agents.latest(widget.id)
```

Key Vault is a dedicated left-navigation panel for creating/unlocking a local vault and adding, renaming, rotating, or deleting named keys. Password fields mask values; editing a key never loads its old value into the form. The example uses `openai-api` consistently; users can choose other names.

Persist a versioned AES-256-GCM envelope with a random 96-bit IV per write. Derive the nonextractable encryption key from a user passphrase with PBKDF2-SHA256 (600,000 iterations, random 128-bit salt). Encrypt names and values together. Store only ciphertext, salt, and IV in localStorage, scoped to this browser profile and Runme origin; no Drive or notebook export includes the vault. The passphrase is not saved; forgotten passphrases and cleared browser data are not recoverable. While unlocked, trusted browser JS shares the app's authority; this is not an XSS isolation boundary or a cloud vault.

`keyvault.getKey(name)` returns a process-local opaque reference containing only its name when serialized. `agents.setKey(reference)` accepts only a genuine reference and binds authentication to the OpenAI API. Resolve the current value for each request rather than copying it into a durable descriptor. Lock, rotation, removal, and cross-tab vault changes pause existing streams. Reload/pagehide locks the vault. Missing names and locked vaults produce errors without secret values. Unlock explicitly and resume observation. Web Locks plus ciphertext comparisons reject stale writes; storage failures preserve previous keys, and invalid ciphertext is never automatically deleted.

Keep `agents.configure({ baseUrl, getHeaders })` as an advanced integration point for application-owned proxies. Configuration remains in memory. No server credential broker is added, and browser code cannot read the Python runner's local key file. Vault writes/unlock happen in the sidebar, not in saved notebook source. Sandbox code cannot retrieve keys or install authentication providers.

The transport uses GET session, GET items, GET turns, and GET events?stream=true with OpenAI-Beta: agents=v1. Reject redirects and avoid including upstream error bodies or authorization headers in notebook diagnostics. Refresh headers for each request. Sandbox cells may monitor and control already-configured monitors through host methods; they cannot install credential-provider callbacks. WebMCP can use the same read/control methods and create a monitor in a targeted notebook by inserting/executing a JS cell.

## Implementation and validation

Add the transport and controller under app/src/lib/agents; expose agents through AppKernel globals and the sandbox bridge. Emit application/vnd.runme.agent-monitor+json into normal cell outputs. Extend ActionOutputItems with a native monitor renderer and add Edit/Render controls to cells containing that MIME. Keep normal code cells unchanged.

Test SSE framing across chunk boundaries, HTTP errors, abort cleanup, root/subagent outcomes, done without deltas, replay deduplication, reconnect hydration, pagination during live output, source/render behavior, malformed descriptors, and safe Markdown. Run focused tests, type checking, lint, and a production build. Validate the complete notebook path with a synthetic local Go REST/SSE service; live API validation requires the user's chosen authenticated transport.

## Follow-ups

A deployable proxy or runner-backed adapter can bridge the existing local credential workflow. Other follow-ups are explicit send/cancel helpers, request-specific approval forms, subagent drill-down, durable snapshots for offline viewing, and a shared subscription per session. The first version makes each monitor independent so one cell's controls do not affect another.

## References

- [Events and items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)
- [List items](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/subresources/items/methods/list)
- [Streaming events](https://developers.openai.com/api/reference/resources/beta/subresources/agents/streaming-events)
- [Original Python cell](https://runme.gateway.unified-0.internal.api.openai.org/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1wI3tWRteb5QPfwYyrLNennNv8K09hTq8%2Fview#cell=30d5dbb16a214c9f9db8f9c9f757e32b)
