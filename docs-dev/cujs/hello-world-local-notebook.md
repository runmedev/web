# Scenario: Hello world local notebook execution

This scenario is the first "hello world" acceptance test for the notebook UX.
It validates that a user can configure a local runner and execute a basic bash
cell end-to-end.

## Preconditions

- Runme backend agent is running at `http://localhost:9977`.
- Web UI is running at `http://localhost:5173`.
- `agent-browser` is installed and available on `PATH`.

## User journey

1. Start the web UI using pnpm.
2. Start the Runme server.
3. Create a new local notebook with one bash cell: `echo "hello world"`.
4. Use AppConsole to add a local runner endpoint.
5. Open the local notebook.
6. Execute the bash cell.
7. Verify execution output contains `hello world`.

## Machine-verifiable acceptance criteria

- [ ] The App Console accepts `runmeRunners.ensure("local", "ws://localhost:9977/ws", { setDefault: true })`.
- [ ] `runmeRunners.get()` reports `local: ws://localhost:9977/ws`.
- [ ] `runmeRunners.getDefault()` reports runner `local` after `runmeRunners.ensure(..., { setDefault: true })`.
- [ ] The workspace tree shows notebook `scenario-hello-world.runme.md`.
- [ ] Clicking the notebook opens a tab with the notebook name.
- [ ] Running the first cell completes without a blocking runner error.
- [ ] The rendered output area includes `hello world`.
