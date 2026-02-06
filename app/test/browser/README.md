# Browser Integration Tests

Automated UI tests for jl-notebook using `agent-browser`.

## Prerequisites

1. **Backend** running on port 9977:
   ```bash
   cd runme && go run ./ agent --config=${HOME}/.runme-agent/config.dev.yaml serve
   ```

2. **Frontend** running on port 5173:
   ```bash
   cd web && pnpm run dev:app
   ```

   Or use `just run` from the project root to start both.

3. **agent-browser** installed and on PATH.

## Running

```bash
cd web/app/test/browser
./test-notebook-ui.sh
```

## What it tests

| Test | Description |
|------|-------------|
| Initial load | Opens app, verifies it renders |
| Explorer | Checks WorkspaceExplorer renders without picker button |
| Console | Checks for console/terminal area |
| Notebook files | Verifies test fixtures appear in explorer |
| Folder expansion | Expands tree folders |
| Open notebook | Clicks a notebook to open it |
| Notebook rendering | Verifies notebook content renders |

## Output

- Screenshots saved to `test-output/*.png`
- DOM snapshots saved to `test-output/*.txt`
- Exit code: 0 = all pass, 1 = failures, 2 = missing dependencies

## Test fixtures

The tests rely on notebooks in `../fixtures/notebooks/`:
- `hello-world.json` - simple JSON notebook
- `cell-types.json` - multi-language cells
- `basic-test.runme.md` - basic echo tests
- `cell-types-test.runme.md` - bash/python/js cells
- `ui-test.runme.md` - visual/UX testing
- `large-payload-test.runme.md` - >100KB payload test
