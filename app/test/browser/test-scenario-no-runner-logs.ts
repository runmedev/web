import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = "http://localhost:5173";
const BACKEND_URL = "http://localhost:9977";
const SCENARIO_NOTEBOOK_NAME = "scenario-no-runner.runme.md";
const CUJ_ID_TOKEN = process.env.CUJ_ID_TOKEN?.trim() ?? "";
const CUJ_ACCESS_TOKEN = process.env.CUJ_ACCESS_TOKEN?.trim() ?? CUJ_ID_TOKEN;
const tokenExpiresAtEnv = Number(process.env.CUJ_TOKEN_EXPIRES_AT ?? "");
const CUJ_TOKEN_EXPIRES_AT = Number.isFinite(tokenExpiresAtEnv) && tokenExpiresAtEnv > Date.now()
  ? tokenExpiresAtEnv
  : Date.now() + 5 * 60 * 1000;

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-no-runner-logs-walkthrough.webm");

let passCount = 0;
let failCount = 0;
let totalCount = 0;

function run(command: string): { status: number; stdout: string; stderr: string } {
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "20000");
  const result = spawnSync(command, {
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
    ? `\n[scenario-timeout] command timed out after ${timeoutMs}ms: ${command}\n`
    : "";
  if (timedOut && command.trim().startsWith("agent-browser ")) {
    throw new Error(timeoutHint.trim());
  }
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${timeoutHint}`,
  };
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

function firstRef(snapshot: string, pattern: RegExp): string | null {
  const line = snapshot
    .split("\n")
    .find((entry) => pattern.test(entry));
  if (!line) {
    return null;
  }
  const legacyRef = line.match(/@[a-zA-Z0-9]+/);
  if (legacyRef) {
    return legacyRef[0];
  }
  const currentRef = line.match(/\[ref=([^\]]+)\]/);
  return currentRef ? currentRef[1] : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppConsoleCommand(consoleRef: string, command: string): string {
  run(`agent-browser click ${consoleRef}`);
  run(`agent-browser type ${consoleRef} "${escapeDoubleQuotes(command)}"`);
  run("agent-browser press Enter");
  run("agent-browser wait 900");
  return run("agent-browser get text '#app-console-output'").stdout;
}

function runWithRetry(command: string, attempts = 3, waitMs = 1200): void {
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = run(command);
    if (result.status === 0) {
      return;
    }
    lastError = result.stderr || result.stdout || `exit ${result.status}`;
    if (attempt < attempts - 1) {
      run(`agent-browser wait ${waitMs}`);
    }
  }
  throw new Error(`Command failed after ${attempts} attempts: ${command}\n${lastError}`);
}

function readBottomPaneCollapsed(): "true" | "false" | "missing" {
  const output = run(
    `agent-browser eval "(() => {
      const pane = document.getElementById('bottom-pane');
      if (!pane) return 'missing';
      return pane.getAttribute('data-collapsed') || 'false';
    })()"`,
  ).stdout;
  if (output.includes("true")) return "true";
  if (output.includes("false")) return "false";
  return "missing";
}

function toggleBottomPane(): boolean {
  const output = run(
    `agent-browser eval "(() => {
      const toggle = document.getElementById('bottom-pane-collapse-toggle');
      if (!toggle) return 'missing';
      toggle.click();
      return 'clicked';
    })()"`,
  ).stdout;
  return output.includes("clicked");
}

function setBottomPaneCollapsed(collapsed: boolean): boolean {
  const desired = collapsed ? "true" : "false";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = readBottomPaneCollapsed();
    if (current === desired) {
      return true;
    }
    if (current === "missing") {
      return false;
    }
    if (!toggleBottomPane()) {
      return false;
    }
    run("agent-browser wait 350");
  }
  return readBottomPaneCollapsed() === desired;
}

function clickLogsTab(): boolean {
  const snapshot = run("agent-browser snapshot -i").stdout;
  const logsRef = firstRef(snapshot, /tab "Logs"/i);
  if (!logsRef) {
    return false;
  }
  run(`agent-browser click ${logsRef}`);
  return true;
}

function parseStateToken(output: string): "visible" | "not-visible" | "missing" | "" {
  const normalized = output.trim().replace(/^['"]|['"]$/g, "");
  if (normalized === "visible") {
    return "visible";
  }
  if (normalized === "not-visible") {
    return "not-visible";
  }
  if (normalized === "missing") {
    return "missing";
  }
  return "";
}

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const file of [
  "scenario-no-runner-logs-01-initial.png",
  "scenario-no-runner-logs-02-after-seed.txt",
  "scenario-no-runner-logs-03-runner-state.txt",
  "scenario-no-runner-logs-04-opened-notebook.txt",
  "scenario-no-runner-logs-05-after-run.txt",
  "scenario-no-runner-logs-06-logs-pane.txt",
  "scenario-no-runner-logs-07-logs-visible.png",
  "scenario-no-runner-logs-auth-seed.txt",
]) {
  rmSync(join(OUTPUT_DIR, file), { force: true });
}
rmSync(MOVIE_PATH, { force: true });

if (run("command -v agent-browser").status !== 0) {
  console.error("ERROR: agent-browser is required on PATH");
  process.exit(2);
}
if (run(`curl -sf ${FRONTEND_URL}`).status !== 0) {
  console.error(`ERROR: frontend is not running at ${FRONTEND_URL}`);
  process.exit(1);
}
if (
  run(`curl -sf ${BACKEND_URL}`).status !== 0 &&
  run("nc -z localhost 9977").status !== 0
) {
  console.error(`ERROR: backend is not running at ${BACKEND_URL}`);
  process.exit(1);
}

runWithRetry(`agent-browser open ${FRONTEND_URL}`);
runWithRetry(`agent-browser record restart ${MOVIE_PATH}`);
run("agent-browser wait 3200");

if (CUJ_ID_TOKEN) {
  const idTokenLiteral = `'${CUJ_ID_TOKEN.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const accessTokenLiteral = `'${CUJ_ACCESS_TOKEN.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const authSeed = run(
    `agent-browser eval "(async () => {
      localStorage.setItem('oidc-auth', JSON.stringify({
        access_token: ${accessTokenLiteral},
        id_token: ${idTokenLiteral},
        token_type: 'Bearer',
        scope: 'openid email',
        expires_at: ${CUJ_TOKEN_EXPIRES_AT}
      }));
      return localStorage.getItem('oidc-auth') ? 'ok' : 'missing';
    })()"`,
  );
  const authSeedResult = `${authSeed.stdout}\n${authSeed.stderr}`.trim();
  writeArtifact("scenario-no-runner-logs-auth-seed.txt", authSeedResult);
  if (authSeed.status === 0 && authSeedResult.includes("ok")) {
    pass("Injected OIDC auth token");
    run("agent-browser reload");
    run("agent-browser wait 2200");
  } else {
    fail("Failed to inject OIDC auth token");
  }
}

run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-no-runner-logs-01-initial.png")}`);

const seedResult = run(
  `agent-browser eval "(async () => {
  const ln = window.app?.localNotebooks;
  if (!ln) return 'missing-local-notebooks';
  const notebook = {
    metadata: {},
    cells: [
      {
        refId: 'cell_no_runner',
        kind: 2,
        languageId: 'bash',
        value: 'echo \\\"runner missing\\\"',
        metadata: {},
        outputs: []
      }
    ]
  };
  await ln.files.put({
    id: 'local://file/${SCENARIO_NOTEBOOK_NAME}',
    uri: 'local://file/${SCENARIO_NOTEBOOK_NAME}',
    name: '${SCENARIO_NOTEBOOK_NAME}',
    doc: JSON.stringify(notebook),
    updatedAt: new Date().toISOString(),
    parent: 'local://folder/local',
    lastSynced: '',
    remoteId: '',
    lastRemoteChecksum: ''
  });
  return 'ok';
})()"`,
).stdout;

if (seedResult.includes("ok")) {
  pass("Created local notebook fixture");
} else {
  fail("Failed to create local notebook fixture");
}

let snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-no-runner-logs-02-after-seed.txt", snapshot);

const consoleRef = firstRef(snapshot, /Terminal input/i);
if (!consoleRef) {
  fail("Did not find AppConsole terminal input");
} else {
  const firstDelete = runAppConsoleCommand(consoleRef, 'app.runners.delete("default")');
  const secondDelete = runAppConsoleCommand(consoleRef, 'app.runners.delete("local")');
  const runnersState = runAppConsoleCommand(consoleRef, "app.runners.get()");
  writeArtifact(
    "scenario-no-runner-logs-03-runner-state.txt",
    `${firstDelete}\n${secondDelete}\n${runnersState}`,
  );
  if (runnersState.includes("No runners configured.")) {
    pass("Removed all configured runners");
  } else {
    fail("Runners were still configured before execution");
  }
}

snapshot = run("agent-browser snapshot -i").stdout;
const expandFolderRef = firstRef(snapshot, /button "Expand folder"/i);
if (expandFolderRef) {
  run(`agent-browser click ${expandFolderRef}`);
  run("agent-browser wait 900");
  snapshot = run("agent-browser snapshot -i").stdout;
}

const notebookPattern = new RegExp(escapeRegExp(SCENARIO_NOTEBOOK_NAME), "i");
let notebookRef = firstRef(snapshot, notebookPattern);
for (let attempt = 0; !notebookRef && attempt < 4; attempt += 1) {
  run("agent-browser wait 700");
  snapshot = run("agent-browser snapshot -i").stdout;
  notebookRef = firstRef(snapshot, notebookPattern);
}

if (notebookRef) {
  run(`agent-browser click ${notebookRef}`);
  run("agent-browser wait 1400");
  pass("Opened no-runner scenario notebook");
} else {
  fail("Could not find no-runner scenario notebook in explorer");
}

snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-no-runner-logs-04-opened-notebook.txt", snapshot);

if (setBottomPaneCollapsed(true)) {
  run("agent-browser wait 600");
  pass("Ensured bottom pane is minimized");
} else {
  fail("Could not minimize bottom pane before execution");
}

const runRef =
  firstRef(snapshot, /Run code/i) ??
  firstRef(snapshot, /Run cell/i) ??
  firstRef(snapshot, /\bRun\b/i);
if (runRef) {
  run(`agent-browser click ${runRef}`);
  run("agent-browser wait 1800");
  pass("Attempted to execute cell without runners");
} else {
  fail("Could not find Run control for the no-runner cell");
}

snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-no-runner-logs-05-after-run.txt", snapshot);

if (setBottomPaneCollapsed(false)) {
  run("agent-browser wait 600");
  pass("Expanded bottom pane after execution");
} else {
  fail("Could not expand bottom pane after execution");
}

let logsTabVisible = false;
const tabAttemptStates: string[] = [];
for (let attempt = 0; attempt < 8; attempt += 1) {
  if (!clickLogsTab()) {
    tabAttemptStates.push(`attempt=${attempt + 1} click=missing-tab-ref`);
    break;
  }
  run("agent-browser wait 300");
  const visibleStateRaw = run(
    `agent-browser eval "(() => {
      const logsTab = document.getElementById('bottom-pane-tab-logs');
      const consoleTab = document.getElementById('bottom-pane-tab-console');
      const logsContent = document.getElementById('bottom-pane-content-logs');
      const pane = document.getElementById('bottom-pane');
      if (!logsTab || !consoleTab || !logsContent || !pane) return 'missing';
      const logsActive =
        logsTab.getAttribute('data-state') === 'active' ||
        logsTab.getAttribute('aria-selected') === 'true';
      const consoleInactive =
        consoleTab.getAttribute('data-state') === 'inactive' ||
        consoleTab.getAttribute('aria-selected') === 'false';
      const visible = window.getComputedStyle(logsContent).display !== 'none';
      const paneExpanded = pane.getAttribute('data-collapsed') === 'false';
      return logsActive && consoleInactive && visible && paneExpanded ? 'visible' : 'not-visible';
    })()"`,
  ).stdout;
  const visibleState = parseStateToken(visibleStateRaw);
  tabAttemptStates.push(
    `attempt=${attempt + 1} state=${visibleState || "unknown"} raw=${JSON.stringify(visibleStateRaw.trim())}`,
  );
  if (visibleState === "missing") {
    break;
  }
  if (visibleState === "visible") {
    logsTabVisible = true;
    break;
  }
}
writeArtifact("scenario-no-runner-logs-08-tab-debug.txt", tabAttemptStates.join("\n"));

if (logsTabVisible) {
  pass("Opened Logs tab");
  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-no-runner-logs-07-logs-visible.png")}`);
} else {
  fail("Could not visibly activate Logs tab");
}

const logsText = run(
  `agent-browser eval "(() => {
    const content = document.getElementById('bottom-pane-content-logs');
    if (!content) return '';
    return content.innerText || content.textContent || '';
  })()"`,
).stdout;
writeArtifact("scenario-no-runner-logs-06-logs-pane.txt", logsText);
if (
  logsText.includes(
    "Runme backend server is not running. Please start it and try again.",
  )
) {
  pass("Observed backend-unavailable error in Logs tab");
} else {
  fail("Logs tab did not show backend-unavailable execution error");
}

run("agent-browser wait 1500");

run("agent-browser record stop");
if (CUJ_ID_TOKEN) {
  run(`agent-browser eval "localStorage.removeItem('oidc-auth'); 'ok'"`);
}
run("agent-browser close");

console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
