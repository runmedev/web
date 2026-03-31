# CUJ: AppKernel JavaScript Notebook Execution

## Goal

Validate that a notebook code cell can execute in-browser using the `AppKernel`
runner (no remote websocket runner), and that execution updates notebook cell
outputs using the standard notebook output model.

## Primary User Story

1. User opens the web app.
2. User opens or creates a notebook with a JavaScript code cell.
3. User selects the JS runner mode for that cell (`browser` or `sandbox`).
4. User runs the cell.
5. The cell executes locally via AppKernel (`JSKernel` for browser mode, sandbox
   kernel for sandbox mode).
6. The notebook cell shows stdout/stderr output and exit status in the normal
   notebook output area.

## Scope (v0)

- `AppKernel` supports only `javascript` language cells.
- Execution is local/in-browser (no Runme backend websocket required).
- JS cells show runner mode selector with `browser` (default) and `sandbox`.
- Output is emitted as notebook `CellOutput[]` updates.
- Rich output should use MIME-based outputs (for example `text/html`) rather
  than imperative DOM mutation APIs.

## Preconditions

- Web UI is running locally (for example `http://localhost:5173`).
- AppKernel runner is implemented and visible in the runner selector.
- No remote Runme backend is required for this CUJ.

## Test Notebook Fixture (Minimal)

Use a notebook fixture such as
`app/test/fixtures/notebooks/appkernel-javascript-test.runme.md` with at least
these JavaScript cells:

### Cell A: stdout + JSON

```javascript
console.log("appkernel hello");
console.log(JSON.stringify({ ok: true, n: 42 }));
```

### Cell B: helper access

```javascript
const nb = runme.getCurrentNotebook();
console.log(Boolean(nb));
console.log(nb ? nb.getName() : "no-notebook");
```

### Cell C: failure path

```javascript
throw new Error("appkernel expected test error");
```

## User Journey

1. Open the notebook fixture.
2. Set the JS runner mode to `browser` for Cell A (default expected).
3. Run Cell A.
4. Verify stdout output appears in the notebook cell output area.
5. Run Cell B.
6. Verify helper access works and prints notebook information.
7. Run Cell C.
8. Verify stderr/error output appears and cell is marked with non-zero exit.

## Machine-Verifiable Acceptance Criteria

- [ ] JS runner selector includes `browser` and `sandbox`.
- [ ] JS runner selector defaults to `browser`.
- [ ] Selecting `AppKernel` does not require a remote runner endpoint.
- [ ] Running Cell A updates the cell output with stdout containing `appkernel hello`.
- [ ] Running Cell A produces no websocket runner error toast.
- [ ] Running Cell B prints `true` for notebook handle existence.
- [ ] Running Cell C records error text containing `appkernel expected test error`.
- [ ] Running Cell C sets non-zero exit metadata for the cell.
- [ ] Re-running Cell A clears/replaces stale outputs according to notebook execution semantics.

## Output/State Assertions (Implementation-Level)

- Cell output updates are applied through notebook cell mutation (`getCell` / `updateCell`)
  rather than a parallel renderer-owned state model.
- AppKernel execution writes standard notebook `CellOutputItem` entries for stdout/stderr.
- `pid` metadata is absent/null for AppKernel runs.

## Negative Cases

- Unsupported language under AppKernel (e.g. `python`):
  - Return actionable error:
    - `AppKernel only supports javascript cells in v0.`
- AppKernel helper throws:
  - Error is captured in cell stderr/error output.
  - Cell execution is marked failed (non-zero exit).

## Automation Follow-Up

Add a browser CUJ script under `app/test/browser/` after AppKernel is implemented:

- `test-scenario-appkernel-javascript.ts`
- add to `run-cuj-scenarios.ts` after the scenario is stable

### Proposed browser scenario (agent-browser)

This scenario should intentionally run with no backend runner service. The goal
is to prove AppKernel execution is local and does not depend on websocket runner
transport.

#### Preconditions

- Web UI running at `http://localhost:5173`
- `agent-browser` on `PATH`
- Runme backend **not required** (and preferably not running)

#### Scenario steps

1. Open the app.
2. Open fixture notebook `appkernel-javascript-test.runme.md`.
3. Verify JS runner selector includes `browser` and `sandbox`.
4. Verify selected runner defaults to `browser`.
5. Run Cell A.
6. Assert output contains:
   - `appkernel hello`
   - `{"ok":true,"n":42}`
7. Run Cell B.
8. Assert output contains:
   - `true`
   - notebook name (e.g. `appkernel-javascript-test.runme.md`)
9. Run Cell C.
10. Assert error output contains `appkernel expected test error`.
11. Assert cell failure metadata / non-zero exit indicator is shown.
12. Re-run Cell A and assert stale error output from Cell C is not shown in Cell A.

#### Machine-verifiable assertions (script level)

- DOM assertions:
  - JS runner selector options contain `browser` and `sandbox`
  - selected JS runner value is `browser` by default
  - Cell A output region contains expected stdout text
  - Cell C output region contains expected error text
- App state assertions (`agent-browser eval`):
  - executed cells have `outputs.length > 0`
  - Cell C exit code is non-zero
  - AppKernel cells have no `pid` (null/undefined/0 depending final schema)
- Negative assertion:
  - no runner websocket error toast/log text appears for AppKernel execution

#### Suggested implementation notes

- Reuse helper patterns from `test-scenario-hello-world.ts`:
  - `run()`, `runOrThrow()`, snapshot artifacts, PASS/FAIL accounting
- Use notebook cell labels (`{"name":"..."}`) in the fixture to make buttons and
  output probes deterministic.
- Prefer app-state probing via `agent-browser eval` for exit metadata assertions;
  avoid brittle xterm/canvas scraping.

## Related Design Docs

- `docs-dev/design/appkernel.md`
- `docs-dev/design/drive.md`
