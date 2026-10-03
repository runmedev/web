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

Capture the rendered monitor with notebook context and record assertions. Controller/component tests cover root/subagent completion, replay races, EOF, safe Markdown, malformed descriptors and pagination. NotebookData tests cover browser and sandbox output. The Go fixture drives the manual WebMCP browser CUJ; it is not registered in the automated browser orchestrator yet.
