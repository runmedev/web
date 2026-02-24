---
runme:
  id: codex-walkthrough
  version: v3
---
# Codex Walkthrough Notebook

This notebook walks through configuring and validating the Codex harness in the Runme web app.

## 1) Copy This Notebook Into Your Local Folder

Run this first cell to copy the walkthrough notebook into a user-owned folder.

```bash {"name":"copy-notebook-to-user-folder"}
set -euo pipefail

SOURCE_NOTEBOOK="${SOURCE_NOTEBOOK:-docs/codex-walkthrough.runme.md}"
TARGET_DIR="${TARGET_DIR:-${HOME}/runme-notebooks}"
TARGET_NOTEBOOK="${TARGET_NOTEBOOK:-${TARGET_DIR}/codex-walkthrough.runme.md}"

mkdir -p "${TARGET_DIR}"
cp "${SOURCE_NOTEBOOK}" "${TARGET_NOTEBOOK}"

echo "Copied notebook to: ${TARGET_NOTEBOOK}"
echo "Open this copied notebook in Runme to continue."
```

## 2) Ensure a Runme Runner Is Available

If a runner is not already listening on `localhost:9977`, this cell starts one in the background.

```bash {"name":"ensure-runme-runner"}
set -euo pipefail

RUNME_AGENT_PORT="${RUNME_AGENT_PORT:-9977}"
RUNME_AGENT_CONFIG="${RUNME_AGENT_CONFIG:-${HOME}/.runme-agent/config.dev.yaml}"
RUNME_AGENT_LOG="${RUNME_AGENT_LOG:-${HOME}/.runme-agent/runme-agent.log}"

if nc -z localhost "${RUNME_AGENT_PORT}" >/dev/null 2>&1; then
  echo "Runme runner already listening on localhost:${RUNME_AGENT_PORT}"
  exit 0
fi

mkdir -p "$(dirname "${RUNME_AGENT_LOG}")"
nohup runme agent --config="${RUNME_AGENT_CONFIG}" serve >"${RUNME_AGENT_LOG}" 2>&1 &

sleep 2
if nc -z localhost "${RUNME_AGENT_PORT}" >/dev/null 2>&1; then
  echo "Started runme runner on localhost:${RUNME_AGENT_PORT}"
  echo "Log: ${RUNME_AGENT_LOG}"
else
  echo "Failed to start runme runner. Last log lines:"
  tail -n 40 "${RUNME_AGENT_LOG}" || true
  exit 1
fi
```

## 3) Configure Runner + Codex Harness In App Console

In the Runme **App Console**, run these commands:

```javascript {"name":"app-console-commands"}
app.runners.update("local", "ws://localhost:9977/ws")
app.runners.setDefault("local")

app.harness.update("local-codex", "http://localhost:9977", "codex")
app.harness.setDefault("local-codex")

app.harness.get()
```

Expected: default harness is `local-codex` with adapter `codex`.

## 4) Validate Chat + Notebook Update Flow

1. Open the **AI Chat** panel.
2. Send this prompt:

```text
Add a cell to print("hello world")
```

Expected behavior:
- You see an assistant acknowledgement (for example: `Ok, I'll add a cell to print("hello world")`).
- A new notebook cell containing `print("hello world")` appears.
- A follow-up assistant message confirms the change (for example: `Cell has been added.`).

## 5) Optional: Validate Execute Approval Path

Ask the assistant to run the new cell. If execution requires approval, use App Console:

```javascript {"name":"approve-execute-cells"}
app.runCells(["<cellID>"])
```

Replace `<cellID>` with the pending cell id shown by the app.
