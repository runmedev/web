# Codex Chat Panel

## Purpose

This page describes the in-app path where a user talks to Codex from the Runme
Web AI Chat panel.

Use this doc when the user is inside Runme Web and wants the chat panel to help
with notebook-aware work. This is different from the Codex desktop app
controlling Runme through Chrome and WebMCP.

## What this mode is

In this mode:

- the user opens the `AI Chat` panel in Runme Web,
- Runme routes the chat turn through its configured AI harness,
- Codex, when selected as the harness, acts as the agent runtime for that chat,
- Runme provides notebook context and app helpers to the harness.

The chat panel owns the user interaction. Codex does not need to claim a Chrome
tab, inspect Chrome tabs, or use the Chrome extension to find Runme.

## When to use this mode

Use the in-app chat panel when the user wants to:

- ask questions about the current notebook,
- have Runme add or update notebook cells from chat,
- use notebook-aware assistant workflows without leaving the Runme UI,
- configure or inspect Codex projects from the App Console.

## Codex projects

A Codex project is a Runme configuration record used when Runme starts or
resumes Codex-backed chat work.

Typical project fields include:

- `cwd`
- `model`
- `approvalPolicy`
- `sandboxPolicy`
- `personality`
- optional writable roots or workspace metadata

The project is not the Codex conversation itself. It is the default
configuration context for conversations.

## App Console project commands

Useful commands:

```js
app.codex.project.list()
app.codex.project.create(name, cwd, model, sandboxPolicy, approvalPolicy, personality)
app.codex.project.update(projectId, patch)
app.codex.project.delete(projectId)
app.codex.project.getDefault()
app.codex.project.setDefault(projectId)
```

## Harness selection

The active chat harness determines where Runme sends AI chat turns.

Inspect configured harnesses:

```js
app.harness.get()
app.harness.getDefault()
app.harness.getActiveChatkitUrl()
```

If a deployment has a Codex harness configured, select it by name:

```js
app.harness.setDefault("configured-codex-harness-name")
```

Do not point a chat harness at the Runme runner WebSocket. Runners execute
notebook cells; chat harnesses handle AI chat turns.

## Troubleshooting

If the AI Chat panel does not respond:

- confirm the desired harness is selected with `app.harness.getDefault()`,
- inspect the bottom `Logs` pane,
- check auth or credentials required by the selected harness,
- confirm the notebook context is loaded before asking for notebook edits.

## High-value facts for Codex

- This mode starts from the Runme UI.
- The chat panel is the user-facing surface.
- Do not use Chrome tab claiming or WebMCP just because the active harness is
  Codex-backed.
- For external control of Runme from the Codex desktop app, use
  [codex-chrome-webmcp.md](codex-chrome-webmcp.md).
