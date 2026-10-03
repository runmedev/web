# CUJ: Agent monitor in a JavaScript cell

## Setup

Start the Go fixture with `go run testing/fake-agents-server.go` and Runme at `http://127.0.0.1:5173`. Use a separate local browser session. Create a notebook through WebMCP, record its concrete URI, and select AppKernel browser JS. No credentials or live API session are used.

## Journey and acceptance

1. Execute `agents.configure({baseUrl:'http://127.0.0.1:8989/v1'}); agents.monitor('sess_demo',{pageSize:5})` in a targeted notebook cell. Read the cell back: exit code is 0 and output includes `application/vnd.runme.agent-monitor+json`.
2. Verify Render is selected, the editor is hidden, the widget has five items, GFM tables and fenced code render, and connection is live while the root turn remains in progress.
3. Select Older using the same runtime controller (`await agents.older(widgetId)`). Assert five earlier items remain visible as events arrive, and the Latest update count increases. Newer/Latest return to the bounded live page.
4. Toggle Edit then Render. Assert source is visible only in Edit and the existing monitor remains mounted; neither operation executes the cell.
5. Pause via `agents.pause(widgetId)`. Assert connection is paused and items remain readable. Resume via `await agents.resume(widgetId)` and assert live state returns.
6. Reload the browser. The saved widget is disconnected, requires Connect, and does not contain credentials or serialized messages. Configure the connection in a new execution before connecting.
7. In Render, type a multiline message into **Message the agent**. Shift+Enter must not submit; Enter or Send submits one request. The Go fixture echoes a synthetic reply. Verify the draft clears only after acceptance, both the user message and reply appear, and history returns to Latest.
8. Pause monitoring: the composer retains its draft but Send is disabled. Resume and send. Controller/component tests verify failed delivery preserves the draft, unchanged retries reuse the idempotency key, double sends are blocked, composition Enter does not submit, and reconnect does not resend. Do not send test messages to a real agent session.

Capture the rendered monitor with notebook context and record assertions. Controller/component tests cover root/subagent completion, replay races, EOF, safe Markdown, malformed descriptors and pagination. NotebookData tests cover browser and sandbox output. The Go fixture drives the manual WebMCP browser CUJ; it is not registered in the automated browser orchestrator yet.


## Named key vault

1. Open Key Vault from the left navigation on an isolated test origin. Create a vault with a test passphrase and add two synthetic named keys; values must be masked and cleared after saving.
2. Reload: the vault is locked. An incorrect passphrase must preserve the existing vault. Unlock with the correct passphrase and verify both names.
3. Run browser JS `agents.setKey(keyvault.getKey("openai-api"))` with a synthetic test key. Verify no key value appears in notebook source, output descriptors, help, snapshots, or persisted browser ciphertext. Authentication failures must not echo credentials.
4. Lock the vault with a monitor active. Observation must pause. Unlock/resume to reconnect; deleted or renamed keys must fail until the cell selects an existing name.
5. Rotate and rename a key, reject duplicate names, and remove a key using inline confirmation. In a second tab, verify edits lock stale state rather than overwriting the first tab's changes.
6. Keep existing synthetic Go transport tests for rendered messages/events/pagination. A real API credential is entered by the user through the vault sidebar, never by editing the notebook.
