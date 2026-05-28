# Using Codex

## Purpose

This page explains the two supported ways Codex fits into Runme Web.

The important distinction is where the interaction starts:

- inside Runme Web, through the `AI Chat` panel,
- outside Runme Web, from the Codex desktop app controlling a Chrome tab
  through WebMCP.

## In-app chat panel mode

Use this mode when the user is working in Runme Web and opens the `AI Chat`
panel.

In this mode:

- Runme owns the chat UI,
- Runme sends chat turns through its configured harness,
- Codex may be the selected agent runtime,
- Runme provides notebook and app context to the harness.

The chat panel does not require Chrome tab claiming or session matching.

Read [codex-chat-panel.md](codex-chat-panel.md).

## Chrome and WebMCP mode

Use this mode when the user is chatting with Codex in the Codex desktop app and
that conversation needs to operate Runme in the user's Chrome browser.

In this mode:

- Codex inspects Chrome tabs,
- Codex claims one Runme tab,
- Runme exposes WebMCP tools from that tab,
- Codex verifies the tab session before reading or mutating notebooks.

Runme exposes the tab session in the URL as `?session=<session-id>` and inside
AppKernel as:

```js
await app.getSessionID()
```

Read [codex-chrome-webmcp.md](codex-chrome-webmcp.md).

## Codex projects

In Runme Web, a `project` is a Runme concept, not a first-class Codex
app-server concept.

A project is a named bundle of defaults that Runme uses when it creates or
resumes Codex-backed work.

Typical project fields include:

- `cwd`
- `model`
- `approvalPolicy`
- `sandboxPolicy`
- `personality`
- optional writable roots or workspace metadata

The simplest mental model is:

- project = default settings,
- thread = a Codex conversation.

Project selection matters because new or resumed Codex threads may use a
different working directory, model, approval behavior, or sandbox behavior.

## App Console Commands

Useful commands:

```js
app.codex.project.list()
app.codex.project.create(name, cwd, model, sandboxPolicy, approvalPolicy, personality)
app.codex.project.setDefault(projectId)
```

These commands manage Runme's local project definitions.
