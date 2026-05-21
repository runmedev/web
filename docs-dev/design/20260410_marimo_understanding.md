# Understanding marimo for Runme integration

Date: 2026-04-10

## Goal

Build a working understanding of marimo's notebook architecture, especially the parts that matter for a possible Runme integration:

- where notebook source is stored
- where code executes
- how the frontend and backend communicate
- how notebook edits, execution state, dependency graph state, and persisted storage stay in sync
- whether file operations and code execution can be separated cleanly enough for a notebook to live on one machine while executing on another

## Current understanding

marimo notebooks are stored as Python files. In a normal remote VM setup, the marimo server and Python kernel run on the VM, and the browser is only the UI. If the browser connects to the VM over SSH port forwarding or another tunnel, notebook execution and notebook save/load both happen on the VM unless an external sync layer, mounted filesystem, or custom storage layer is added.

The frontend/backend boundary is typed but appears to be an internal application protocol rather than a stable public protocol. The frontend uses generated OpenAPI types for REST requests and receives typed websocket notifications from the backend.

When a user runs a cell, the frontend sends a small execution request to the backend, not a serialized dependency graph. The request includes the selected cell IDs and the current source code for those cells:

```ts
{
  cellIds: [...],
  codes: [...]
}
```

The backend converts this into an execution command for the session's kernel. The kernel compiles the code, registers or re-registers changed cells in its in-memory dataflow graph, computes parent/child relationships from definitions and references, and then determines which cells should execute or become stale based on the reactive execution mode.

Notebook document edits are a separate flow. Code changes, cell creation/deletion, moves, names, and cell config updates are represented as document transactions such as `set-code`, `create-cell`, `delete-cell`, `move-cell`, `reorder-cells`, `set-name`, and `set-config`. These keep the frontend and server-side session document aligned, but do not by themselves mean the code has executed.

Persistence is also a separate flow. Saving a notebook sends the full notebook payload, including cell IDs, code, names, configs, filename, layout, and whether to persist. Running a cell updates the kernel graph and runtime state; saving writes the notebook representation to storage.

The kernel sends execution results and graph-derived metadata back to the frontend over websocket notifications. Important notifications include cell state/output updates, run completion, and variable dependency metadata such as which variables are declared by and used by which cells.

## How marimo works

At a high level, marimo has four related but distinct representations of a notebook:

- the persisted notebook source, normally a Python file
- the server-side notebook document for the active session
- the frontend editor state
- the kernel runtime state, including the dataflow graph, globals, outputs, UI element values, and stale status

When a session starts, the server-side file manager loads the notebook file into an internal app representation. The session then instantiates the kernel by sending the cell IDs and code to the kernel as execution requests. The kernel does not discover notebook cells by reading the file directly during execution; it receives cell source from the session.

When the user edits the notebook, the frontend records local editor state and sends document transactions to the backend. These transactions keep the server-side notebook document in sync with the frontend, but they are separate from execution. A code edit can be synced to the server document without having been run in the kernel.

When the user runs a cell, the frontend sends the selected cell IDs and the current source for those cells. The kernel compiles those cells, updates its graph, marks dependent cells stale or schedules them to run depending on the reactive execution mode, and streams results back to the frontend.

When the user saves, the frontend sends a full save payload to the backend. The backend file manager persists the notebook representation. This is a separate operation from graph mutation and execution.

## Native Python notebook format

marimo's native notebook format is a Python module, not JSON. A saved notebook typically looks like this:

```python
import marimo

__generated_with = "0.13.14"
app = marimo.App()


@app.cell
def _(mo):
    mo.md("""# Title""")
    return


@app.cell
def _(mo):
    slider = mo.ui.slider(1, 10)
    return (slider,)


@app.cell
def _(slider):
    print(slider.value)
    return


@app.cell
def _():
    import marimo as mo
    return (mo,)


if __name__ == "__main__":
    app.run()
```

Cells are delineated by Python decorators and function definitions, primarily `@app.cell`. marimo serializes each cell as a function whose arguments are the variables that cell depends on and whose returned tuple contains the variables the cell defines. This means the saved file carries enough structure for marimo to recover the cell list and dependency information from ordinary Python syntax.

Cell metadata is also encoded in Python. Non-default cell config is written as decorator arguments such as `@app.cell(hide_code=True, disabled=True)`. Setup cells are represented with `with app.setup:`, and top-level function/class cells can use `@app.function` or `@app.class_definition`.

When marimo converts a Jupyter `.ipynb` file, `marimo convert notebook.ipynb -o notebook.py` reads the Jupyter cell sources and metadata, converts markdown cells to `mo.md(...)`, and emits this native marimo Python module format. marimo can also convert regular Python scripts or Jupytext `py:percent` scripts into marimo notebooks; `# %%` markers are an input conversion format, not the native marimo cell delimiter.

Cell outputs are not stored in the native `.py` notebook. They live in the running session/runtime state and are recomputed by execution. Persisted outputs require an export or snapshot format such as HTML, session export, or `.ipynb` export with outputs. For Runme, this means the native marimo file should be treated as source plus metadata, not as the source of truth for output state.

## File usage

marimo's current server/session architecture is file-oriented, but the kernel does not fundamentally need to read the notebook file in order to execute cells. For execution, the kernel needs cell IDs, source code, cell configuration, app metadata, UI element state, and runtime configuration. The file path is used as runtime context and identity, not as the direct source of code during each run.

The filename is still semantically important today. marimo uses it to:

- load the notebook into the server-side app/file manager before kernel instantiation
- save and rename the persisted notebook
- set `sys.argv[0]`
- set `__file__` in the kernel's `__main__` module
- add the notebook directory to `sys.path` so local imports work
- choose cache identity and runtime context filename
- improve tracebacks and debugpy behavior
- support file watching and reload flows
- support script metadata/package-management behavior tied to a path

This suggests an integration direction that fits Runme better: move notebook reading/writing to the frontend or to Runme's existing document/storage layer, and treat marimo's backend/kernel as an execution service that receives notebook contents and a logical filename. That would preserve the kernel's execution model while avoiding a requirement that the execution VM be the system of record for notebook storage.

The hard part is not basic code execution; the hard part is making filename-dependent behavior explicit. A remote execution service would need either a real mounted path or a synthetic/logical path with clear semantics for `__file__`, relative imports, caches, script metadata, file watching, and tracebacks.

## Integration implications

The conceptual separation exists:

- document edits
- execution requests
- kernel graph/runtime state
- persistence

However, marimo currently coordinates these through a single server/session model. The session owns the server-side document, file manager, websocket connection, and kernel lifecycle. The notebook file manager is local-filesystem oriented, and execution assumes a current session whose document and kernel are kept together.

That means storing a notebook on one machine while executing it on another is probably feasible, but it is not just a matter of swapping the save backend. It would likely require formalizing a split between:

- a document/storage service that owns notebook contents and versions
- an execution service that owns the kernel, dependency graph, outputs, and UI element state
- a synchronization protocol that makes code versions explicit when execution requests cross service boundaries

## Open questions

- Is marimo's document transaction protocol stable enough to build against, or should Runme treat it as an implementation detail?
- What is the minimal API surface needed to run a marimo notebook backed by a non-local storage provider?
- Can the kernel execution service be made authoritative only for runtime state, with notebook contents/versioning owned elsewhere?
- How should version conflicts be handled if a stored notebook changes while a remote kernel has an older graph in memory?
- What state, if any, must be colocated with the kernel besides code, UI element values, outputs, and the dependency graph?
- Would Runme integrate more naturally by embedding marimo as-is behind a remote server, or by contributing a storage/session abstraction upstream?

## References

- [marimo issue #5506: Can Marimo run code cells on a remote backend while UI is hosted on GitHub Pages?](https://github.com/marimo-team/marimo/issues/5506)
  Closest match to the Runme architecture question. The issue asks whether a static-hosted marimo UI can execute cells on a remote backend such as EC2 or EKS, and whether a custom kernel could send code to a remote execution environment. A maintainer responded that this was not possible at the time and that marimo does not have a Jupyter-style custom kernel mechanism.

- [marimo discussion #5505: Can Marimo run code cells on a remote backend while UI is hosted on GitHub Pages?](https://github.com/marimo-team/marimo/discussions/5505)
  Discussion linked from issue #5506. It frames the core split we care about: hosting the UI from a static environment while sending execution to a remote backend because static environments have limits around threading, sockets, and networking.

- [marimo issue #7949: Consider exporting `mount` as a library](https://github.com/marimo-team/marimo/issues/7949)
  Frontend embedding issue. The requester wants to embed marimo inside another tool, store notebook code inside Grist, intercept RPC/kernel events such as notebook save, send RPC events back to the kernel, and delay initial frontend loading. This is relevant to a Runme integration because it points at making the marimo frontend mountable/embeddable instead of only loading as a self-starting SPA.

- [marimo issue #5318: Enable percent-script and .ipynb formats via pluggable AppFileManagers](https://github.com/marimo-team/marimo/issues/5318)
  Storage/file-format extensibility issue. It proposes pluggable file managers or serializers to support formats like `.ipynb` and percent-script notebooks. A maintainer suggested a better abstraction such as `NotebookSerializer`. This is relevant because moving notebook reading/writing out of the remote execution VM may need a similar abstraction boundary.

- [marimo issue #5625: API Limitation: Marimo-Server-Token not accessible for automated notebook creation](https://github.com/marimo-team/marimo/issues/5625)
  Automation/API bootstrapping issue. It notes that external API clients can have trouble creating notebooks programmatically when they cannot obtain the server skew-protection token. This matters for any non-marimo frontend or automation client that needs to drive marimo through its HTTP API.

- [marimo issue #7625: MCP server: Add edit tools](https://github.com/marimo-team/marimo/issues/7625)
  Agent/tooling issue. It asks for MCP tools such as notebook editing and running stale cells so agents can iterate without a human manually running cells. The comments discuss the current best workflow, file watching, `watcher_on_save = "autorun"`, and direct run-cell needs.

- [marimo issue #8955: "AI-First" DX: Improving External File Sync and LLM-Friendly Documentation plus Claude-code-marimo-skill and others](https://github.com/marimo-team/marimo/issues/8955)
  External-edit and agent workflow issue. Maintainers point to marimo pair as a direction where agents talk directly to the marimo server/kernel instead of editing the Python file. This is adjacent to a custom frontend or Runme integration because it relies on direct server/kernel interaction rather than local file edits as the primary interface.

- [marimo issue #8176: MCP server: rendered output preview for visual cells](https://github.com/marimo-team/marimo/issues/8176)
  Programmatic output inspection issue. It proposes returning rendered images of visual cell outputs so agents can evaluate charts, plots, and widgets. This is relevant if Runme wants to use marimo as an execution engine while still validating rich output outside the native marimo browser UI.

- [marimo issue #7820: Option to include code in `app.embed`](https://github.com/marimo-team/marimo/issues/7820)
  Embedding/composition issue. It requests that `app.embed` include child notebook code alongside outputs. This is less directly about external frontends, but relevant to marimo's supported composition surface and how much notebook UI/state is available when embedding marimo apps.

## Source pointers

marimo source references from the initial investigation:

- frontend run request: `frontend/src/components/editor/cell/useRunCells.ts`
- frontend network request client: `frontend/src/core/network/requests-network.ts`
- backend execution endpoint: `marimo/_server/api/endpoints/execution.py`
- execution request model: `marimo/_server/models/models.py`
- kernel commands: `marimo/_runtime/commands.py`
- kernel graph mutation and execution: `marimo/_runtime/runtime.py`
- dataflow graph: `marimo/_runtime/dataflow/graph.py`
- dependency edge computation: `marimo/_runtime/dataflow/edges.py`
- document transaction frontend mapping: `frontend/src/core/cells/document-changes.ts`
- document transaction backend endpoint: `marimo/_server/api/endpoints/document.py`
- notebook document model: `marimo/_messaging/notebook/document.py`
- document change types: `marimo/_messaging/notebook/changes.py`
- websocket notifications: `marimo/_messaging/notification.py`
