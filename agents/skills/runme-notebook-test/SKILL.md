---
name: runme-notebook-test
description: Test and validate Runme markdown notebooks. Use when the user needs to run notebook tests, validate notebooks execute without errors, list code blocks, or run specific cells programmatically.
allowed-tools: Bash(runme-nb:*),Bash(runme:*)
---

# Runme Notebook Testing

Test and validate the Runme notebook web app and markdown notebooks.

## MANDATORY: After Any Web App Code Change

**Before doing anything else**, run the smoke test to verify the app boots:

```bash
cd web/app && bash test/browser/test-smoke.sh [port]   # default port 5173
```

This catches runtime TypeErrors, missing methods, and blank screen issues that `vite build` does NOT detect (Vite skips type checking). Also run `pnpm run typecheck` in `web/app/` when modifying core files (`AppState.ts`, `App.tsx`, storage modules, context providers).

**If the smoke test fails, fix the error before proceeding with any other testing.**

## Quick start

```bash
runme-nb test <notebook.md>           # Run all blocks, report pass/fail
runme-nb list <notebook.md>           # List all code blocks
runme-nb run <block-name> <notebook>  # Run specific block
runme-nb validate <notebook.md>       # Validate notebook structure
```

## Commands

### Test notebook (run all blocks)

```bash
# Run all code blocks and check for errors
runme-nb test README.md

# Run with verbose output
runme-nb test README.md --verbose

# Run and save output to file
runme-nb test README.md --output results.txt
```

### List code blocks

```bash
# List all named code blocks
runme-nb list README.md

# List with details (language, first command)
runme-nb list README.md --details
```

### Run specific blocks

```bash
# Run a single named block
runme-nb run install-deps README.md

# Run multiple blocks
runme-nb run "install-deps,build,test" README.md
```

### Validate notebook

```bash
# Check notebook structure without executing
runme-nb validate README.md

# Parse and show notebook structure
runme-nb parse README.md
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | All blocks executed successfully |
| 1 | One or more blocks failed |
| 2 | Notebook not found or parse error |

## Environment variables

```bash
RUNME_PATH="/path/to/runme"  # Custom runme binary path
RUNME_TIMEOUT=300            # Execution timeout in seconds
```

## Examples

### CI/CD testing

```bash
# Test all notebooks in a directory
for nb in docs/*.md; do
  runme-nb test "$nb" || exit 1
done
```

### Selective testing

```bash
# Only run setup and test blocks
runme-nb run "setup,test" README.md
```

### Validation without execution

```bash
# Just check the notebook parses correctly
runme-nb validate README.md && echo "Notebook is valid"
```

## Integration with existing tools

This skill wraps the `runme` CLI. For advanced usage, you can use runme directly:

```bash
# Direct runme usage
runme list --filename README.md
runme run --filename README.md --all --skip-prompts
```

## Programmatic testing patterns

### Test a notebook returns success

```bash
if runme-nb test notebook.md; then
  echo "All tests passed"
else
  echo "Tests failed"
  exit 1
fi
```

### Capture output for analysis

```bash
output=$(runme-nb test notebook.md --verbose 2>&1)
if [ $? -eq 0 ]; then
  echo "Success"
else
  echo "Failed with output:"
  echo "$output"
fi
```

## Browser Testing with agent-browser

For visual verification and testing the web interface, use the `agent-browser` skill.

### Prerequisites

Start the backend and frontend servers:

```bash
# Using justfile (recommended)
just run

# Or manually:
# Terminal 1: cd runme && go run ./ agent --config=${HOME}/.runme-agent/config.dev.yaml serve
# Terminal 2: cd web && pnpm run dev:app
```

The backend runs on port **9977** and frontend on **5173** (or 5174 if 5173 is busy).

### Basic workflow

```bash
# 1. Open the web interface
agent-browser open http://localhost:5173

# 2. Take a screenshot to verify UI loaded
agent-browser screenshot notebook-ui.png

# 3. Get interactive elements
agent-browser snapshot -i

# 4. Interact with elements using refs from snapshot
agent-browser click @e7    # Example: expand folder
agent-browser click @e12   # Example: add cell
```

### Testing scenarios

#### Verify UI renders correctly

```bash
agent-browser open http://localhost:5173
agent-browser wait 2000
agent-browser screenshot ui-check.png
```

#### Create and interact with a notebook

```bash
# Open the app
agent-browser open http://localhost:5173
agent-browser snapshot -i

# Expand Local Notebooks (find the expand button ref)
agent-browser click @e7

# Create a new notebook by clicking Add Folder or similar
agent-browser snapshot -i
agent-browser click @e5

# Take screenshot of result
agent-browser screenshot notebook-created.png
```

#### Verify notebook cells render

```bash
agent-browser open http://localhost:5173
agent-browser snapshot -i
# Navigate to open a notebook, then:
agent-browser screenshot cells-view.png
```

### Limitations

- **Element refs change**: After navigation or DOM updates, run `agent-browser snapshot -i` again to get fresh refs
- **Timing**: Use `agent-browser wait 2000` after navigation to let the UI render
- **Authentication**: The web UI may require login; use the App Console to set credentials if needed
- **File access**: The web UI accesses files via the backend; ensure the backend is configured to serve the correct directories

### When to use browser testing

| Use Case | Recommended Approach |
|----------|---------------------|
| Validate code blocks execute | `runme-nb test` (CLI) |
| Check notebook structure | `runme-nb validate` (CLI) |
| **Catch blank screen / startup crash** | **`test-smoke.sh`** |
| Verify UI renders correctly | `agent-browser` |
| Test interactive features | `agent-browser` |
| CI/CD pipeline testing | `runme-nb test` (CLI) |
| Visual regression testing | `agent-browser screenshot` |

### Closing the browser

```bash
agent-browser close
```

## Web App Component Testing

The web app uses **Vitest** for unit testing React components.

### Project Structure

```
web/
├── packages/
│   └── react-components/     # Reusable components (tests work here)
│       └── src/components/Actions/__tests__/
└── app/                      # Main app (jsdom has module issues)
    └── src/components/Actions/
```

### Running Tests

```bash
# Run tests in react-components package (recommended - stable)
cd web/packages/react-components
pnpm run test:run

# Run specific test file
npx vitest run src/components/Actions/__tests__/MarkdownCell.test.tsx --reporter=verbose
```

### Known Issues

- **app/ tests have jsdom module compatibility issues** with `html-encoding-sniffer` and `@exodus/bytes`
- **packages/react-components tests work correctly** - put new tests there
- **Monaco Editor requires mocking** in tests to avoid hanging

### Mocking Monaco Editor

Always mock the Editor component in tests to avoid Monaco loading issues:

```tsx
vi.mock('../Editor', () => ({
  default: ({
    id,
    value,
    onChange,
    onEnter,
  }: {
    id: string
    value: string
    language: string
    onChange: (v: string) => void
    onEnter: () => void
  }) => (
    <div data-testid="mock-editor">
      <textarea
        data-testid={`editor-input-${id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  ),
}))
```

### Cell Component Testing Pattern

For testing cell components like MarkdownCell:

```tsx
// 1. Create a stub CellData class
class StubCellData {
  snapshot: parser_pb.Cell
  updateCalls: parser_pb.Cell[] = []

  constructor(cell: parser_pb.Cell) {
    this.snapshot = cell
  }

  update(cell: parser_pb.Cell) {
    this.updateCalls.push(cell)
    this.snapshot = cell
  }
}

// 2. Create a test cell
const cell = create(parser_pb.CellSchema, {
  refId: 'test-cell',
  kind: parser_pb.CellKind.MARKUP,
  languageId: 'markdown',
  value: '# Test',
  outputs: [],
  metadata: {},
})

// 3. Render with stub
const stub = new StubCellData(cell) as unknown as CellData
render(<MarkdownCell cellData={stub} />)
```

### react-markdown API Changes (v10+)

The `react-markdown` v10 API changed - `className` prop is no longer supported:

```tsx
// ❌ Old (v9 and earlier)
<ReactMarkdown className="prose">
  {content}
</ReactMarkdown>

// ✅ New (v10+)
<div className="prose">
  <ReactMarkdown>
    {content}
  </ReactMarkdown>
</div>
```

### Adding New Cell Types

When adding new cell types (like MarkdownCell):

1. **Create component in `packages/react-components`** - export via `src/components/index.tsx`
2. **Create app wrapper** - bridge between CellData and simple props
3. **Modify Action component** - detect cell type and render appropriate component
4. **Add tests in `packages/react-components/src/components/Actions/__tests__/`**

Example cell type detection:

```tsx
const isMarkdownCell = useMemo(() => {
  if (!cell) return false
  if (cell.kind === parser_pb.CellKind.MARKUP) return true
  const lang = (cell.languageId ?? '').toLowerCase()
  return lang === 'markdown' || lang === 'md'
}, [cell])

if (isMarkdownCell) {
  return <MarkdownCell cellData={cellData} />
}
```

### Security Considerations

- **Disable `rehypeRaw`** by default for markdown rendering (XSS prevention)
- Use `remark-gfm` for GitHub-flavored markdown features
- Sanitize any user-generated content before rendering as HTML

## JL-Notebook Test Fixtures

The jl-notebook project has pre-built test fixtures for validating the ContentsService storage layer and notebook rendering pipeline.

### Fixture Locations

All fixtures at `web/app/test/fixtures/notebooks/`:

**JSON fixtures** (Vitest unit tests for `contents.test.ts`):

| File | Purpose |
|------|---------|
| `hello-world.json` | Single bash cell, basic rendering |
| `cell-types.json` | Multi-language cells (bash, python, js) |
| `subdirectory/nested-notebook.json` | Nested directory listing |

**Runme markdown fixtures** (CLI + browser integration tests):

| File | Blocks | Purpose |
|------|--------|---------|
| `basic-test.runme.md` | `echo-test`, `date-test` | Basic execution validation |
| `cell-types-test.runme.md` | `bash-hello`, `python-calc`, `js-objects`, `verify-all` | Multi-language + rich markdown |
| `ui-test.runme.md` | `multiline-output`, `special-chars`, `unicode-chars`, `env-info`, `empty-output`, `single-char` | Edge cases and visual rendering |
| `large-payload-test.runme.md` | `check-size`, `section-001`..`section-N` | ~152KB payload for base64 chunking |

### Safety

All `.runme.md` fixtures are **safe to execute** — they use only echo/print statements with no filesystem modifications, network calls, or side effects. They are designed for:

1. **CLI validation**: `runme-nb validate` and `runme-nb test`
2. **ContentsService pipeline**: Loaded via ContentsService -> ParserService (markdown deserialization)
3. **Browser rendering**: Displayed in WorkspaceExplorer when backend `contentsRootDir` points to `web/app/test/fixtures/notebooks`

### Relationship to ContentsService Testing

The fixtures serve two testing layers:

- **Unit tests** (`contents.test.ts`, 62 tests): JSON fixtures are loaded by mocked `fetch` calls simulating ConnectRPC responses. No running backend needed.
- **Integration tests**: `.runme.md` fixtures are served by the real Go backend's ContentsService. The backend config (`~/.runme-agent/config.dev.yaml`) sets `contentsRootDir` to point at the fixtures directory. The frontend's WorkspaceExplorer auto-mounts this directory and renders the notebooks.

### Running jl-notebook Integration Tests

```bash
# Validate all .runme.md fixtures
for nb in web/app/test/fixtures/notebooks/*.runme.md; do
  runme-nb validate "$nb" || echo "FAIL: $nb"
done

# Execute all .runme.md fixtures
for nb in web/app/test/fixtures/notebooks/*.runme.md; do
  runme-nb test "$nb" || echo "FAIL: $nb"
done

# Run unit tests
cd web/app && npx vitest run src/storage/contents.test.ts

# Run automated browser test (requires `just run`)
cd web/app && bash test/browser/test-notebook-ui.sh
```

### Loading Notebooks with Cells for Browser Testing

There are three ways to get a notebook with cells into the browser UI for visual testing:

#### Method 1: Programmatic via Local Store (recommended for automation)

Use `page.evaluate()` to create a notebook entry in IndexedDB with protobuf-format JSON, then click to open it in the explorer.

**Critical requirements:**
- Cell JSON must use **protobuf integer enums** (`kind: 2` for CODE), not string enums (`"CELL_KIND_CODE"`)
- Each cell **must include a `refId` field** — without it, cells will be silently ignored
- The doc is stored as a JSON string in the `doc` field of the IndexedDB files table

```javascript
// Step 1: Create notebook with cells via page.evaluate()
await page.evaluate(() => {
  const notebookJson = JSON.stringify({
    cells: [
      {
        refId: "cell_001",
        kind: 2,  // CODE (must be integer, not string)
        value: "const x = 42;\nconsole.log(x);",
        languageId: "js",
        metadata: {},
        outputs: []
      },
      {
        refId: "cell_002",
        kind: 2,
        value: "console.log('Hello world');",
        languageId: "js",
        metadata: {},
        outputs: []
      }
    ],
    metadata: {}
  });

  const ln = window.app.localNotebooks;
  return ln.create("local://folder/local", "test-notebook.json")
    .then(item => ln.files.update(item.uri, { doc: notebookJson }));
});

// Step 2: Expand Local Notebooks in the explorer tree
// Step 3: Click the file name to open it
// Step 4: Cells will render with their code content
```

**Protobuf cell kind values:**
| Value | Meaning |
|-------|---------|
| `0` | UNSPECIFIED |
| `1` | MARKUP (markdown) |
| `2` | CODE |

**Common mistakes that cause empty notebooks:**
- Missing `refId` on cells → cells are silently dropped during `loadNotebook()`
- Using string enum `"CELL_KIND_CODE"` instead of integer `2`
- Not closing/reopening the tab after updating the doc (the NotebookData caches the initial load)

#### Method 2: Add cells programmatically after opening

Open an empty notebook, then use `NotebookData.appendCodeCell()` to add cells one at a time:

```javascript
// After opening an empty notebook, click "Add first cell" button,
// or use appendCodeCell() if you have a reference to NotebookData
```

This is simpler but slower — each cell requires a separate UI interaction or API call, and you can't pre-populate cell content without typing into the editor.

#### Method 3: ContentsService backend (for .runme.md fixtures)

If the Go backend is running with `contentsRootDir` configured, `.runme.md` fixtures are served via ContentsService and the backend handles markdown→notebook deserialization. This is the most realistic path but requires the backend.

### Browser Test Script

The automated browser test script at `web/app/test/browser/test-notebook-ui.sh` runs 7 test phases:

1. **Initial UI load** — Opens the app and verifies it renders
2. **Explorer verification** — Checks WorkspaceExplorer panel is visible
3. **Console detection** — Looks for the App Console area
4. **Notebook file listing** — Verifies test notebooks appear in the explorer tree
5. **Folder expansion** — Expands tree items to reveal nested content
6. **Notebook opening** — Clicks a notebook to open it
7. **Rendering verification** — Checks that notebook cells render

Screenshots and DOM snapshots are saved to `web/app/test/browser/test-output/`.
