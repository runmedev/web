---
name: agent-monitors
title: Agent session monitors
description: Render Agents API sessions in JavaScript cells with live Markdown, tool details, turn status, and history pagination.
order: 20
---

# Agent session monitors

Use an AppKernel JavaScript cell to display an Agents API session as an interactive widget. Messages render Markdown; tools and unfamiliar items expand to structured details. The separate Activity disclosure contains the latest 100 stream events.

Configure a trusted browser-accessible API root once with `agents.configure({ baseUrl, getHeaders })`. The optional async `getHeaders` provider supplies authorization headers without persisting credentials in the notebook. Do not put API keys in cell source. A same-origin authenticated proxy can omit the provider. The Python runner's local key files are not accessible to browser JavaScript. This release does not include a proxy or credential broker.

After configuring the connection, set a session ID and run the following cell using **JS → browser**. Sandbox cells can monitor a connection already configured by browser JS.

```js
const widget = agents.monitor('YOUR_SESSION_ID', { pageSize: 50 })
```

## Read and monitor

**Edit** shows the source and **Render** shows the widget, without running the cell again. Editing keeps observation active. Press Run to apply changed source. The JS cell finishes immediately; the separate root-turn status tracks agent completion.

**Older** and **Newer** page through saved items, with at most the configured page size visible. **Latest** returns to the live window. New output never replaces an older page while you read it. Scroll to the live bottom to follow incoming output automatically.

**Pause monitoring** stops this widget's requests, not the agent. **Resume monitoring** reloads saved state and reconnects. A closed stream displays Disconnected; it does not imply completion. Session status, root-turn status, and connection status are separate. Child-turn completion does not complete the root turn.

Saved widget outputs contain only a session ID, widget ID, version, and page size. Reopening a notebook requires Connect. Credentials and live messages are not serialized into the widget output. Required actions are shown for inspection; submit responses, new messages, or cancellation through your agent client.

Runtime controls use the descriptor returned by `agents.monitor`: `agents.get(widget.id)`, `agents.pause(widget.id)`, `await agents.resume(widget.id)`, `await agents.older(widget.id)`, `await agents.newer(widget.id)`, and `agents.latest(widget.id)`. `agents.help()` lists the commands.

## Synthetic local demo

Start `go run testing/fake-agents-server.go` from the repository and Runme on port 5173. Configure `agents.configure({ baseUrl: 'http://127.0.0.1:8989/v1' })`, then run `agents.monitor('sess_demo', { pageSize: 5 })`. This fixture contains 125 items and emits live text every two seconds. No real agent or credentials are involved.

An executable version is available in `docs/agent-monitors.json`.
