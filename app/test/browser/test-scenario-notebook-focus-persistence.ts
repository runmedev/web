import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = process.env.CUJ_FRONTEND_URL ?? "http://localhost:5173";
const NOTEBOOK_NAME = "scenario-notebook-focus.json";
const NOTEBOOK_URI = `local://file/${NOTEBOOK_NAME}`;
const MARKDOWN_CELL_ID = "md_focus_cell";
const STORAGE_KEY = "runme/notebook-active-cells";
const LOCAL_DB_NAME = "runme-local-notebooks";

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-notebook-focus-persistence-walkthrough.webm");
const AGENT_BROWSER_SESSION = process.env.AGENT_BROWSER_SESSION?.trim() ?? "";
const AGENT_BROWSER_PROFILE = process.env.AGENT_BROWSER_PROFILE?.trim() ?? "";
const AGENT_BROWSER_HEADED = (process.env.AGENT_BROWSER_HEADED ?? "false")
  .trim()
  .toLowerCase() === "true";
const AGENT_BROWSER_KEEP_OPEN = (process.env.AGENT_BROWSER_KEEP_OPEN ?? "false")
  .trim()
  .toLowerCase() === "true";

let passCount = 0;
let failCount = 0;
let totalCount = 0;

function run(
  command: string,
  options?: { timeoutMs?: number; throwOnAgentBrowserTimeout?: boolean },
): { status: number; stdout: string; stderr: string } {
  const effectiveCommand = withAgentBrowserOptions(command);
  const timeoutMs = options?.timeoutMs ?? Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "15000");
  const result = spawnSync(effectiveCommand, {
    shell: true,
    encoding: "utf-8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const errorCode =
    typeof result.error === "object" && result.error !== null && "code" in result.error
      ? String((result.error as { code?: string }).code ?? "")
      : "";
  const timedOut = errorCode === "ETIMEDOUT";
  const timeoutHint = timedOut
    ? `\n[scenario-timeout] command timed out after ${timeoutMs}ms: ${effectiveCommand}\n`
    : "";
  const shouldThrowOnTimeout = options?.throwOnAgentBrowserTimeout ?? true;
  if (
    timedOut &&
    shouldThrowOnTimeout &&
    effectiveCommand.trim().startsWith("agent-browser ")
  ) {
    throw new Error(timeoutHint.trim());
  }
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${timeoutHint}`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function withAgentBrowserOptions(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith("agent-browser ")) {
    return command;
  }
  const leadingWhitespace = command.slice(0, command.length - trimmed.length);
  const subcommand = trimmed.slice("agent-browser ".length);
  const args: string[] = [];
  if (AGENT_BROWSER_SESSION) {
    args.push("--session", shellQuote(AGENT_BROWSER_SESSION));
  }
  if (AGENT_BROWSER_PROFILE) {
    args.push("--profile", shellQuote(AGENT_BROWSER_PROFILE));
  }
  if (AGENT_BROWSER_HEADED) {
    args.push("--headed");
  }
  const prefix = ["agent-browser", ...args].join(" ");
  return `${leadingWhitespace}${prefix} ${subcommand}`;
}

function runOrThrow(command: string): string {
  const result = run(command);
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr}`);
  }
  return result.stdout;
}

function pass(message: string): void {
  totalCount += 1;
  passCount += 1;
  console.log(`[PASS] ${message}`);
}

function fail(message: string): void {
  totalCount += 1;
  failCount += 1;
  console.log(`[FAIL] ${message}`);
}

function writeArtifact(name: string, content: string): void {
  writeFileSync(join(OUTPUT_DIR, name), content, "utf-8");
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function decodeAgentBrowserEvalOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}

mkdirSync(OUTPUT_DIR, { recursive: true });
rmSync(MOVIE_PATH, { force: true });
for (const file of [
  "scenario-notebook-focus-persistence-01-seed.json",
  "scenario-notebook-focus-persistence-02-storage-after-edit.json",
  "scenario-notebook-focus-persistence-03-after-reload-snapshot.txt",
  "scenario-notebook-focus-persistence-04-after-reload-state.json",
  "scenario-notebook-focus-persistence-05-after-reload.png",
]) {
  rmSync(join(OUTPUT_DIR, file), { force: true });
}

if (run("command -v agent-browser").status !== 0) {
  console.error("ERROR: agent-browser is required on PATH");
  process.exit(2);
}

if (run(`curl -sf ${FRONTEND_URL}`).status !== 0) {
  console.error(`ERROR: frontend is not running at ${FRONTEND_URL}`);
  process.exit(1);
}

let startedRecording = false;

try {
  runOrThrow(`agent-browser open ${FRONTEND_URL}`);
  runOrThrow(`agent-browser record restart ${MOVIE_PATH}`);
  startedRecording = true;
  run("agent-browser wait 2200");

  const seedResult = decodeAgentBrowserEvalOutput(
    run(
    `agent-browser eval "(async () => {
      const openLocalDb = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('${LOCAL_DB_NAME}');
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('files')) {
            db.createObjectStore('files', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('folders')) {
            db.createObjectStore('folders', { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const runTransaction = (db, storeName, mode, callback) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = callback(store);
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error ?? request?.error);
        tx.onabort = () => reject(tx.error ?? request?.error);
      });
      const notebook = {
        metadata: {},
        cells: [
          {
            refId: '${MARKDOWN_CELL_ID}',
            kind: 1,
            languageId: 'markdown',
            value: '# Focus persistence\\n\\nEdit me after reload.',
            metadata: {},
            outputs: []
          }
        ]
      };
      const notebookDoc = JSON.stringify(notebook);
      const db = await openLocalDb();
      await runTransaction(db, 'folders', 'readwrite', (store) => store.put({
        id: 'local://folder/local',
        name: 'Local Notebooks',
        remoteId: '',
        children: ['${NOTEBOOK_URI}'],
        lastSynced: ''
      }));
      await runTransaction(db, 'files', 'readwrite', (store) => store.put({
        id: '${NOTEBOOK_URI}',
        name: '${NOTEBOOK_NAME}',
        remoteId: '${NOTEBOOK_URI}',
        lastSynced: '',
        lastRemoteChecksum: '',
        doc: notebookDoc,
        md5Checksum: ''
      }));
      db.close();
      localStorage.setItem('runme/openNotebooks', JSON.stringify([
        { uri: '${NOTEBOOK_URI}', name: '${NOTEBOOK_NAME}', type: 'file', children: [], parents: ['local://folder/local'] }
      ]));
      localStorage.setItem('runme/currentDoc', '${NOTEBOOK_URI}');
      localStorage.removeItem('${STORAGE_KEY}');
      return JSON.stringify({ status: 'ok' });
    })()"`,
    ).stdout,
  );
  writeArtifact("scenario-notebook-focus-persistence-01-seed.json", seedResult);
  if (seedResult.includes('"status":"ok"')) {
    pass("Seeded local markdown notebook");
  } else {
    fail("Failed to seed local markdown notebook");
  }

  run("agent-browser reload");
  run("agent-browser wait 2400");

  const openEditorResult = run(
    `agent-browser eval "(async () => {
      const rendered = document.querySelector('#markdown-rendered-${MARKDOWN_CELL_ID}');
      if (!(rendered instanceof HTMLElement)) return 'missing-rendered-markdown';
      rendered.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      return document.querySelector('#markdown-editor-${MARKDOWN_CELL_ID}')
        ? 'ok'
        : 'missing-markdown-editor';
    })()"`,
  ).stdout.trim();
  if (openEditorResult.includes("ok")) {
    pass("Opened markdown cell in editor mode");
  } else {
    fail("Failed to open markdown cell in editor mode");
  }

  run("agent-browser wait 600");

  run(
    `agent-browser eval "(async () => {
      const textarea = document.querySelector('#markdown-editor-${MARKDOWN_CELL_ID} textarea');
      if (!(textarea instanceof HTMLElement)) return 'missing-editor-textarea';
      textarea.focus();
      return document.activeElement === textarea ? 'ok' : 'focus-missed';
    })()"`,
  );
  run("agent-browser wait 400");

  const storageAfterEdit = decodeAgentBrowserEvalOutput(
    run(
    `agent-browser eval "${escapeDoubleQuotes(`(() => {
      const raw = localStorage.getItem('${STORAGE_KEY}');
      return raw || '';
    })()`)}"`,
    ).stdout,
  );
  writeArtifact(
    "scenario-notebook-focus-persistence-02-storage-after-edit.json",
    storageAfterEdit,
  );
  if (storageAfterEdit.includes(MARKDOWN_CELL_ID) && storageAfterEdit.includes('"focusRole":"editor"')) {
    pass("Persisted active markdown editor state");
  } else {
    fail("Did not persist active markdown editor state");
  }

  run("agent-browser reload");
  run("agent-browser wait 2400");

  const afterReloadSnapshot = run("agent-browser snapshot -i").stdout;
  writeArtifact(
    "scenario-notebook-focus-persistence-03-after-reload-snapshot.txt",
    afterReloadSnapshot,
  );

  const afterReloadState = decodeAgentBrowserEvalOutput(
    run(
    `agent-browser eval "${escapeDoubleQuotes(`(() => {
      const editor = document.querySelector('#markdown-editor-${MARKDOWN_CELL_ID}');
      const rendered = document.querySelector('#markdown-rendered-${MARKDOWN_CELL_ID}');
      const active = document.activeElement;
      return JSON.stringify({
        hasEditor: Boolean(editor),
        hasRendered: Boolean(rendered),
        activeElementTag: active?.tagName ?? '',
        activeElementId: active?.id ?? '',
      });
    })()`)}"`,
    ).stdout,
  );
  writeArtifact(
    "scenario-notebook-focus-persistence-04-after-reload-state.json",
    afterReloadState,
  );
  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-notebook-focus-persistence-05-after-reload.png")}`);

  if (afterReloadState.includes('"hasEditor":true') && !afterReloadState.includes('"hasRendered":true')) {
    pass("Reload restored markdown cell in editor mode");
  } else {
    fail("Reload did not restore markdown cell in editor mode");
  }
} catch (error) {
  fail(`Scenario execution error: ${String(error)}`);
} finally {
  if (startedRecording) {
    run("agent-browser record stop", {
      timeoutMs: 30000,
      throwOnAgentBrowserTimeout: false,
    });
  }
  if (!AGENT_BROWSER_KEEP_OPEN) {
    run("agent-browser close");
  }
}

console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
