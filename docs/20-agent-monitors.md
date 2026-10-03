---
name: agent-monitors
title: Agent session monitors
description: Render Agents API sessions in JavaScript cells with live Markdown, tool details, turn status, and history pagination.
order: 20
---

# Agent session monitors

Use an AppKernel JavaScript cell to display an Agents API session as an interactive widget. Messages render Markdown; tools and unfamiliar items expand to structured details. The separate Activity disclosure contains the latest 100 stream events.

Open **Key Vault** in the left navigation. Create a vault with a passphrase, then add a key named `openai-api` using your session-management API key. You can add any number of named keys (within browser storage capacity), edit their names or values, and remove them. Secret fields are masked by default. Use the eye button on the right to show or hide a passphrase or key value while entering it. Visibility resets when the field is cleared or closed. Key values are never included in notebook files or Drive sync.

The vault is encrypted in this browser for this Runme site. Unlock it after reopening Runme; the passphrase is not saved and cannot be recovered. Clearing the site's browser data removes the vault. Only run trusted browser JavaScript while the vault is unlocked. This is local credential storage, not a cloud secret manager.

Run the following cell with **JS → browser**:

```js
agents.setKey(keyvault.getKey('openai-api'))
const widget = agents.monitor('YOUR_SESSION_ID', { pageSize: 50 })
```

`getKey` returns an opaque reference, so logging it shows only the key name. `setKey` selects the OpenAI API at `https://api.openai.com/v1` and resolves the current key for every request. A missing key or locked vault gives a clear error. Locking or changing the vault pauses existing monitors; unlock it and use Resume, or rerun the cell, to reconnect. Deleting or renaming a referenced key requires selecting its replacement.

For an application-owned proxy, advanced browser code may still use `agents.configure({ baseUrl, getHeaders })`. Do not put secrets in notebook code. Sandbox cells can monitor a connection previously configured by browser JS, but cannot access the vault or install credential callbacks. The Python runner's key files are separate and cannot be read by browser JavaScript.

## Read and monitor

**Edit** shows the source and **Render** shows the widget, without running the cell again. Editing keeps observation active. Press Run to apply changed source. The JS cell finishes immediately; the separate root-turn status tracks agent completion.

**Older** and **Newer** page through saved items, with at most the configured page size visible. **Latest** returns to the live window. New output never replaces an older page while you read it. Scroll to the live bottom to follow incoming output automatically.

**Pause monitoring** stops this widget's requests, not the agent. **Resume monitoring** reloads saved state and reconnects. A closed stream displays Disconnected; it does not imply completion. Session status, root-turn status, and connection status are separate. Child-turn completion does not complete the root turn.

Saved widget outputs contain only a session ID, widget ID, version, and page size. Reopening a notebook requires Connect. Credentials and live messages are not serialized into the widget output. Required actions are shown for inspection; submit tool results or cancellation through your agent client.

Runtime controls use the descriptor returned by `agents.monitor`: `agents.get(widget.id)`, `agents.pause(widget.id)`, `await agents.resume(widget.id)`, `await agents.older(widget.id)`, `await agents.newer(widget.id)`, and `agents.latest(widget.id)`. `agents.help()` lists the commands.

## Send a message

Use **Message the agent** below the rendered conversation. Press **Send** or Enter to submit; Shift+Enter inserts a new line. The monitor must be connected. Sending starts a new turn when idle or steers the active turn. The input stays visible while browsing history; a successful send returns to Latest.

The composer prevents simultaneous submissions and clears the draft only after the API accepts it. On a timeout or error, the draft stays available; retry unchanged to reuse its submission ID and avoid duplicates. Editing sends a new message. Reconnecting never sends automatically. Drafts and retry IDs stay in memory for the current widget; reloading or rerunning the cell discards them. After an uncertain send, retry before reloading, or check conversation history before submitting again.

## Synthetic local demo

Start `go run testing/fake-agents-server.go` from the repository and Runme on port 5173. Configure `agents.configure({ baseUrl: 'http://127.0.0.1:8989/v1' })`, then run `agents.monitor('sess_demo', { pageSize: 5 })`. This fixture contains 125 items and emits live text every two seconds. No real agent or credentials are involved.

An executable version is available in `docs/agent-monitors.json`.
