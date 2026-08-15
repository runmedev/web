# CUJ: Direct Jupyter Kernels as Runners

## Goal

Verify the end-to-end journey in which Runme starts an `ipykernel` process,
bridges its ZeroMQ channels to the browser, and exposes that kernel as a target
for notebook cells. A separate Jupyter Server is not part of this flow.

## Preconditions

- Runme Web is running at `http://localhost:5173`.
- A Runme backend with the direct Jupyter kernel API is running at
  `http://localhost:9977`.
- The signed-in user has `RunnerUserRole` permission on that backend.
- The runner host has Python and `ipykernel` installed. Set
  `CUJ_JUPYTER_PYTHON` when the desired interpreter is not `python3`.
- App Console (AppKernel JavaScript) is available.
- A runner named `local` points at the backend and is the default runner.

## Direct Kernel Model

- The browser addresses kernels through a Runme runner, not through a Jupyter
  Server record.
- The start request supplies the complete kernel command as `argv`. It contains
  exactly one `{connection_file}` placeholder, which Runme replaces with the
  generated connection-file path.
- The returned kernel ID is the durable API identifier. The optional name is a
  human-friendly alias used by the UI.
- Cell metadata stores the runner name, kernel ID, and kernel name. It does not
  store a Jupyter Server name.
- Runme owns the kernel process, connection file, HMAC key, ZeroMQ sockets, and
  WebSocket-to-ZeroMQ bridge.

## Step-by-Step User Flow

1. The user opens a notebook containing two Jupyter cells.
2. In App Console, the user ensures the runner exists:

```javascript
app.runners.update('local', 'ws://localhost:9977/ws')
app.runners.setDefault('local')
```

3. The user starts a direct kernel. To use a virtual environment, the first
   argument is the absolute path to that environment's Python executable:

```javascript
const kernel = await jupyter.kernels.start('local', {
  kernelSpec: 'python3',
  name: 'py3-local-1',
  argv: [
    '/workspace/.venv/bin/python',
    '-m',
    'ipykernel_launcher',
    '-f',
    '{connection_file}',
  ],
})
```

4. The user lists kernels owned by the runner:

```javascript
await jupyter.kernels.get('local')
```

5. The result includes `kernel.id`, the name `py3-local-1`, and its current
   execution state.
6. For both Jupyter cells, the user selects runner `local` and kernel
   `py3-local-1`.
7. The first cell defines state:

```python
shared_value = 42
print("set", shared_value)
```

8. The first cell completes and displays `set 42`.
9. The second cell reads the same state:

```python
print("read", shared_value)
```

10. The second cell completes and displays `read 42`, proving both executions
    used the same kernel.
11. The user stops the kernel by its returned ID:

```javascript
await jupyter.kernels.stop('local', kernel.id)
```

12. A subsequent `jupyter.kernels.get("local")` no longer returns that kernel.

The same lifecycle is available through the runner-status Kernels tab, which
can start, refresh, restart, and stop direct kernels without using App Console.

## Machine-Verifiable Acceptance Criteria

- [ ] The scenario verifies the configured Python can import `ipykernel`.
- [ ] `jupyter.kernels.start(runner, options)` sends the full `argv` command and
      returns kernel metadata with an ID.
- [ ] `jupyter.kernels.get(runner)` includes the new kernel.
- [ ] No `jupyter.servers.*` method or server-scoped kernel argument is used.
- [ ] The cell UI exposes runner and kernel selectors.
- [ ] Selecting a kernel persists runner name, kernel ID, and kernel name, with
      no Jupyter Server name.
- [ ] Cell A displays `set 42`.
- [ ] Cell B displays `read 42` without `NameError`.
- [ ] `jupyter.kernels.stop(runner, kernelID)` stops the selected kernel.
- [ ] Browser requests only target Runme's direct kernel HTTP and WebSocket
      endpoints; Runme handles kernel process and ZeroMQ communication.
- [ ] The scenario emits machine-readable probes plus screenshots or video in
      `app/test/browser/test-output/`.

## Negative Paths

1. **Unauthorized start:** use a user without `RunnerUserRole`; kernel creation
   fails with a permission error and no kernel is registered.
2. **Invalid command:** omit `{connection_file}` or provide an executable that
   does not exist; creation fails with a useful error and no live kernel remains.
3. **Stale selection:** stop a selected kernel, then execute a cell that still
   references its ID; execution fails clearly and the user can select or start a
   replacement kernel.
4. **Ownership release during authentication:** release the notebook write lock
   while authorization is pending; the delayed launch must not open a WebSocket
   or mutate the cancelled cell.

## Out of Scope (v0)

- Jupyter Server discovery, registration, or HTTP proxying.
- Widget and arbitrary binary-buffer parity beyond the supported channels
  protocol.
- Automatically discovering every Python virtual environment on a runner.
