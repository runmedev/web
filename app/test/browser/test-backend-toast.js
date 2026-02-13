import { spawnSync } from "node:child_process";

const PORT = process.argv[2] ?? "5173";
const FRONTEND_URL = `http://localhost:${PORT}`;
const BACKEND_PORT = 9977;
const OUTPUT_DIR = new URL("./test-output/", import.meta.url).pathname;
const SCREENSHOT_PATH = `${OUTPUT_DIR}backend-toast.png`;

const RED = "\u001b[0;31m";
const GREEN = "\u001b[0;32m";
const YELLOW = "\u001b[1;33m";
const NC = "\u001b[0m";

const log = (msg) => console.log(`${YELLOW}[TEST]${NC} ${msg}`);
const pass = (msg) => console.log(`${GREEN}[PASS]${NC} ${msg}`);
const fail = (msg) => console.log(`${RED}[FAIL]${NC} ${msg}`);

function run(command, options = {}) {
  const result = spawnSync(command, { shell: true, encoding: "utf-8", ...options });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runOk(command) {
  const result = run(command);
  return result.status === 0;
}

function runOutput(command) {
  const result = run(command);
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

if (!runOk("command -v agent-browser")) {
  console.error("ERROR: agent-browser not on PATH");
  process.exit(2);
}

if (!runOk(`curl -sf ${FRONTEND_URL}`)) {
  console.error(`ERROR: Frontend not running at ${FRONTEND_URL}`);
  process.exit(2);
}

if (runOk(`nc -z localhost ${BACKEND_PORT}`)) {
  console.error(`ERROR: Backend is running on port ${BACKEND_PORT}. Stop it for this test.`);
  process.exit(2);
}

run(`mkdir -p ${OUTPUT_DIR}`);

log(`Opening ${FRONTEND_URL}`);
run(`agent-browser open ${FRONTEND_URL}`);
run("agent-browser wait 3000");

const snapshot = runOutput("agent-browser snapshot -i").stdout;
const localFolderMatch = snapshot.match(/Expand folder Local Notebooks.*ref=([^\]]+)/);
if (!localFolderMatch) {
  fail("Local Notebooks folder not found in explorer");
  run("agent-browser close");
  process.exit(1);
}

run(`agent-browser click @${localFolderMatch[1]}`);
run("agent-browser wait 1000");

let nextSnapshot = runOutput("agent-browser snapshot -i").stdout;
const expandMatch = nextSnapshot.match(/Expand folder" \[ref=([^\]]+)/);
if (expandMatch) {
  run(`agent-browser click @${expandMatch[1]}`);
  run("agent-browser wait 1000");
}

nextSnapshot = runOutput("agent-browser snapshot -i").stdout;
if (!nextSnapshot.includes("test-backend-toast.json")) {
  log("Creating local test notebook");
  run(
    `agent-browser eval "(async () => { const ln = window.app?.localNotebooks; if (!ln) return 'missing-localNotebooks'; const notebookJson = JSON.stringify({ cells: [{ refId: 'cell_001', kind: 2, languageId: 'bash', value: 'echo toast test', metadata: {}, outputs: [] }], metadata: {} }); await ln.files.put({ id: 'local://file/test-backend-toast.json', uri: 'local://file/test-backend-toast.json', name: 'test-backend-toast.json', doc: notebookJson, updatedAt: new Date().toISOString(), parent: 'local://folder/local', lastSynced: '', remoteId: '', lastRemoteChecksum: '' }); return 'ok'; })()"`
  );
}

nextSnapshot = runOutput("agent-browser snapshot -i").stdout;
const collapseMatch = nextSnapshot.match(/Collapse folder" \[ref=([^\]]+)/);
if (collapseMatch) {
  run(`agent-browser click @${collapseMatch[1]}`);
  run("agent-browser wait 500");
}

nextSnapshot = runOutput("agent-browser snapshot -i").stdout;
const expandAgainMatch = nextSnapshot.match(/Expand folder" \[ref=([^\]]+)/);
if (expandAgainMatch) {
  run(`agent-browser click @${expandAgainMatch[1]}`);
  run("agent-browser wait 500");
}

nextSnapshot = runOutput("agent-browser snapshot -i").stdout;
const notebookMatch = nextSnapshot.match(/test-backend-toast.json.*ref=([^\]]+)/);
if (!notebookMatch) {
  fail("Failed to find test-backend-toast.json in explorer");
  run("agent-browser close");
  process.exit(1);
}

run(`agent-browser click @${notebookMatch[1]}`);
run("agent-browser wait 1500");

nextSnapshot = runOutput("agent-browser snapshot -i").stdout;
const runMatch = nextSnapshot.match(/Run code.*ref=([^\]]+)/);
if (!runMatch) {
  fail("Run code button not found");
  run("agent-browser close");
  process.exit(1);
}

const subscribeResult = runOutput(
  `agent-browser eval "(async () => { const { subscribeToast } = await import('http://localhost:${PORT}/src/lib/toast.ts'); window.__toastMessage = null; if (window.__toastUnsub) { window.__toastUnsub(); } window.__toastUnsub = subscribeToast((toast) => { window.__toastMessage = toast?.message || null; }); return true; })()"`
);
if (subscribeResult.status !== 0) {
  fail("Failed to attach toast listener");
  run("agent-browser close");
  process.exit(1);
}

run(`agent-browser click @${runMatch[1]}`);

const statusResult = runOutput(
  `agent-browser eval "(async () => { for (let i = 0; i < 60; i += 1) { const msg = window.__toastMessage; if (msg) return msg; await new Promise((resolve) => setTimeout(resolve, 200)); } return null; })()"`
);
const status = statusResult.stdout;

if (status.includes("Runme backend server is not running")) {
  pass("Backend toast rendered");
} else {
  fail("Backend toast not found");
}

run(`agent-browser screenshot ${SCREENSHOT_PATH}`);
run("agent-browser close");

log(`Screenshot saved to ${SCREENSHOT_PATH}`);

if (status.includes("Runme backend server is not running")) {
  process.exit(0);
}
process.exit(1);
