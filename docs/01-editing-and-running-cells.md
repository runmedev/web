# Editing And Running Cells

## Core editing model

Users edit notebook cells directly in the main notebook pane.

- code cells can be executed,
- markdown cells are rendered,
- notebooks preserve cell order and outputs.

## Execution model

A code cell executes against the active runner for that notebook context.
Runner selection matters. Backend runners, AppKernel, and Jupyter behave
differently.

## What users can do

- run a single code cell from the notebook UI,
- inspect stdout and stderr inline,
- interact with long-running or terminal-style processes in the cell console,
- rerun or clear notebook output through App Console helpers.

## Useful App Console helpers

```js
runme.help()
runme.clear()
runme.clearOutputs()
runme.runAll()
runme.rerun()
```

## Output behavior

- code cell output is kept with the notebook,
- interactive terminal input is supported for console-style execution paths,
- Jupyter output may be translated from kernel messages before rendering.

## High-value facts for Codex

- "Run this notebook" is often best interpreted as `runme.runAll()` or repeated
  cell execution, depending on context.
- If output looks incomplete, inspect the bottom `Logs` pane before assuming the
  cell failed silently.
- Backend execution failures and runner misconfiguration often surface outside
  the cell itself, especially in logs.
