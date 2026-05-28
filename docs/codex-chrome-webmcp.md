# Codex Chrome And WebMCP

## Purpose

This page describes the external-control path where the user is in the Codex
desktop app and asks that Codex conversation to interact with Runme Web through
the user's Chrome browser, the Codex Chrome Extension, and Runme's WebMCP
tools.

Use this doc when the active user surface is the Codex desktop app, not the
Runme Web UI, and Codex needs to inspect, edit, or execute work in an
already-open Runme Web tab. This is different from the Runme AI Chat panel
talking to Codex from inside the app.

## What this mode is

In this mode:

- the user is chatting with Codex in the Codex desktop app,
- that desktop Codex conversation uses Chrome extension access to inspect or
  claim a Chrome tab,
- Runme exposes WebMCP tools from the claimed tab,
- Codex uses those tools and AppKernel helpers to inspect or mutate notebook
  state.

Chrome tab control is exclusive: one Codex thread can control one Chrome tab at
a time. When multiple Codex conversations work with Runme, each conversation
should target a different Runme tab.

## Session id sources

Runme exposes the same browser session id in two places:

- the page URL query parameter: `?session=<session-id>`
- the AppKernel helper: `await app.getSessionID()`

The URL query parameter is the fast routing hint. The AppKernel helper is the
runtime check from inside the tab.

## Required tab selection workflow

When the user names a specific Runme session, Codex should:

1. Inspect open Chrome tabs.
2. Find Runme tabs whose URL contains `session=<requested-session-id>`.
3. Claim only the matching tab.
4. Verify the claimed tab by running AppKernel code:

```js
console.log(await app.getSessionID())
```

5. Continue only if the printed session id matches the requested session id.

If no tab has the requested `session` query parameter, Codex should not guess.
It should ask the user to open or identify the correct Runme tab.

If a tab URL matches but `await app.getSessionID()` returns a different id,
Codex should treat the tab as unsafe for that requested session and avoid
notebook mutations in that tab.

## Finding the current tab session

If Codex is already attached to a Runme tab and needs to report or confirm the
current session, use AppKernel:

```js
const sessionId = await app.getSessionID()
console.log(sessionId)
```

This works from the App Console, AppKernel notebook JavaScript cells, and Codex
`ExecuteCode` calls that run in the Runme AppKernel runtime.

## URL behavior

Runme adds or replaces `session=<session-id>` in the URL on startup while
preserving other query parameters and hash fragments. Session ids are
human-readable random names, for example `calm-harbor`.

Runme uses Web Locks to avoid live-tab session collisions. A tab may briefly
write an initial readable name and then replace it if another Runme tab already
holds that session lock. Codex should read the current URL and still verify with
`await app.getSessionID()` before acting.

The session id is generated per page load. If the user duplicates a Chrome tab,
the browser initially copies the old URL, but the duplicated Runme page should
replace the copied `session` query value with a new session id as soon as the
app starts.

Examples:

```text
https://runme.example/?session=calm-harbor
https://runme.example/?doc=local%3A%2F%2Fdemo.runme.md&session=brave-summit#cell-a
```

Codex should use the `session` query parameter only to locate candidate tabs.
Before taking action, verify with `await app.getSessionID()`.

## Notebook safety rule

For notebook reads or writes, session selection is separate from notebook
selection. After Codex verifies the correct tab session, it must still resolve
the intended notebook to a concrete notebook URI and use that URI or handle for
later notebook operations.

Do not rely on "current notebook" after the initial resolution, because the user
may switch notebooks while Codex is working.

## Relationship to the chat panel

Do not confuse this mode with the Runme AI Chat panel:

- Chrome/WebMCP mode starts from a Codex desktop app conversation.
- The in-app chat panel starts from Runme Web and routes chat turns through the
  configured chat harness.
- Chrome/WebMCP mode needs tab selection and session verification.
- The in-app chat panel does not need Chrome tab claiming.

For the in-app chat panel path, see
[codex-chat-panel.md](codex-chat-panel.md).
