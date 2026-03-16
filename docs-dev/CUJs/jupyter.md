# CUJ: Jupyter Servers and Kernels as Runners

## Goal

Define an end-to-end user journey where:

1. User starts a Jupyter server from a Runme notebook cell.
2. User registers that server in Runme via App Console APIs.
3. User starts/stops kernels via Runme APIs.
4. Kernels appear as selectable runners for notebook cells.

## Preconditions

- Runme web UI is running at `http://localhost:5173`.
- Runme backend/agent is running at `http://localhost:9977`.
- Python environment includes `jupyter` and `ipykernel`.
- App Console (JS/AppKernel) is available.
- Local shell runner (`local`) is configured and can execute bash cells.

## Data Model Assumption

- Jupyter server records include:
  - `name` (for example `local-jupyter`)
  - `runner` (Runme host/proxy runner, for example `local`)
  - `baseUrl` (for example `http://127.0.0.1:8888`)
  - `token`
- Kernels are treated as runners in notebook execution UX.
- A kernel runner belongs to one Jupyter server record.

## Step-by-Step User Flow (What User Does and Sees)

1. User opens or creates a Runme notebook `jupyter-control.runme.md`.
2. User adds a bash cell and runs:

```bash
jupyter server --no-browser --port=8888 > /tmp/jupyter-server.log 2>&1 &
echo $! > /tmp/jupyter-server.pid
sleep 2
```

3. User sees the cell complete successfully and server PID written to `/tmp/jupyter-server.pid`.
4. In the same control notebook, user adds another bash cell and runs:

```bash
jupyter server list --jsonlist
```

5. User sees JSON containing URL/token metadata for `http://127.0.0.1:8888`.
6. User opens Runme App Console.
7. User ensures host runner exists for proxying (example):

```javascript
app.runners.update("local", "ws://localhost:9977/ws");
app.runners.setDefault("local");
```

8. User registers Jupyter server in App Console:

```javascript
jupyter.servers.update("local-jupyter", {
  runner: "local",
  baseUrl: "http://127.0.0.1:8888",
  token: "<token-from-jupyter-server-list>"
});
```

9. User verifies registration:

```javascript
jupyter.servers.get();
```

10. User sees `local-jupyter` in server list with runner `local`.
11. User starts a kernel on that server:

```javascript
jupyter.kernels.start("local-jupyter", {
  kernelSpec: "python3",
  name: "py3-local-1"
});
```

12. User verifies kernel list:

```javascript
jupyter.kernels.get("local-jupyter");
```

13. User sees kernel `py3-local-1` in running state with a kernel id.
14. User opens a notebook with two Python cells:

```python
# Cell A
shared_value = 42
print("set", shared_value)
```

```python
# Cell B
print("read", shared_value)
```

15. For Cell A, user configures execution selectors:
   - Language: `ipython`
   - Runner: `local` (host/proxy runner)
   - Kernel: `py3-local-1` (kernel runner)
16. User runs Cell A and sees status transition idle -> running -> completed.
17. User sees Cell A output: `set 42`.
18. For Cell B, user sets the same execution selectors:
   - Language: `ipython`
   - Runner: `local`
   - Kernel: `py3-local-1`
19. User runs Cell B.
20. User sees Cell B output: `read 42` (variable defined in Cell A is available).
21. User opens Kernel dropdown for another cell and sees `py3-local-1` available.
22. User stops the kernel in App Console:

```javascript
jupyter.kernels.stop("local-jupyter", "py3-local-1");
```

23. User verifies kernel is stopped:

```javascript
jupyter.kernels.get("local-jupyter");
```

24. User sees `py3-local-1` as stopped/absent from active kernel list.
25. User returns to `jupyter-control.runme.md`, adds a bash cell, and runs:

```bash
jupyter server stop 8888
```

26. User sees server stop confirmation in cell output.

## Machine-Verifiable Acceptance Criteria

- [ ] Jupyter server start command runs from a notebook bash cell and exits successfully.
- [ ] `jupyter server list --jsonlist` runs from a notebook bash cell and emits URL/token metadata.
- [ ] App Console accepts `jupyter.servers.update(name, info)` with `runner`, `baseUrl`, `token`.
- [ ] `jupyter.servers.get()` includes `local-jupyter` with runner binding.
- [ ] App Console accepts `jupyter.kernels.start(server, options)` and returns kernel metadata.
- [ ] `jupyter.kernels.get(server)` shows started kernel state and id.
- [ ] Cell execution UI exposes `Language` selector and supports `ipython`.
- [ ] Cell execution UI exposes `Runner` selector and supports `local`.
- [ ] Cell execution UI exposes `Kernel` selector and supports `py3-local-1`.
- [ ] Running Cell A with selected kernel returns `set 42`.
- [ ] Running Cell B with same selected kernel returns `read 42`.
- [ ] Cell B succeeds without `NameError`, proving shared REPL state across cells.
- [ ] Kernel appears in Kernel selector as a runnable target.
- [ ] `jupyter.kernels.stop(server, kernel)` removes/stops it for future runs.
- [ ] `jupyter server stop 8888` runs from a notebook bash cell and reports successful stop.
- [ ] Browser only talks to Runme; Runme handles Jupyter HTTP/WebSocket interactions.

## Negative Path

1. User registers server with invalid token.
2. User runs `jupyter.kernels.start(...)` or executes a cell.
3. User sees explicit auth error and no kernel is marked running.

4. User stops Jupyter server but keeps stale kernel selection in notebook.
5. User runs the cell.
6. User sees connection failure with a recovery hint to restart server or rebind kernel.

## Out of Scope (v0)

- Runme launching Jupyter server process.
- Rich output parity (widgets/comm channels/custom MIME behavior).
- Multi-user access policy and hardening.
