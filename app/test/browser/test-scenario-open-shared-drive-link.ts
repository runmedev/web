import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = "http://localhost:5173";
const FAKE_DRIVE_URL = process.env.CUJ_FAKE_DRIVE_URL?.trim() ?? "http://127.0.0.1:9090";
const SHARED_FILE_URL = "https://drive.google.com/file/d/shared-file-123/view";
const GOOGLE_CLIENT_STORAGE_KEY = "googleClientConfig";
const GOOGLE_AUTH_STORAGE_KEY = "runme/google-auth/token";
const GOOGLE_DRIVE_RUNTIME_STORAGE_KEY = "runme/google-drive/runtime";
const CURRENT_DOC_STORAGE_KEY = "runme/currentDoc";
const WORKSPACE_STORAGE_KEY = "runme/workspace";

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-open-shared-drive-link-walkthrough.webm");

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
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
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
  const currentRef = line.match(/\[ref=([^\]]+)\]/);
  return currentRef ? currentRef[1] : null;
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const file of [
  "scenario-open-shared-drive-link-01-initial.txt",
  "scenario-open-shared-drive-link-02-status.txt",
  "scenario-open-shared-drive-link-03-after-reload.txt",
  "scenario-open-shared-drive-link-04-explorer.txt",
  "scenario-open-shared-drive-link-05-current-doc.txt",
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

runWithRetry(`agent-browser open ${FRONTEND_URL}`);
runWithRetry(`agent-browser record restart ${MOVIE_PATH}`);
run("agent-browser wait 2500");

const seedRuntime = run(
  `agent-browser eval "(async () => {
    localStorage.setItem('${GOOGLE_DRIVE_RUNTIME_STORAGE_KEY}', JSON.stringify({ baseUrl: '${FAKE_DRIVE_URL}' }));
    localStorage.setItem('${GOOGLE_CLIENT_STORAGE_KEY}', JSON.stringify({}));
    localStorage.removeItem('${GOOGLE_AUTH_STORAGE_KEY}');
    localStorage.removeItem('${CURRENT_DOC_STORAGE_KEY}');
    localStorage.setItem('${WORKSPACE_STORAGE_KEY}', JSON.stringify({ items: [] }));
    return 'ok';
  })()"`,
).stdout.trim();

if (seedRuntime.includes("ok")) {
  pass("Seeded fake Drive runtime configuration");
} else {
  fail("Failed to seed fake Drive runtime configuration");
}

runWithRetry(`agent-browser open "${FRONTEND_URL}/?doc=${encodeURIComponent(SHARED_FILE_URL)}"`);
run("agent-browser wait 3500");

let snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-open-shared-drive-link-01-initial.txt", snapshot);

const searchAfterQueue = run(`agent-browser eval "window.location.search"`).stdout.trim();
if (!searchAfterQueue.includes("?doc=")) {
  pass("Removed shared doc query parameter after queueing");
} else {
  fail("Shared doc query parameter was not removed after queueing");
}

if (/Drive Link Status/i.test(snapshot)) {
  pass("Opened Drive Link Status tab while shared link is pending");
} else {
  fail("Drive Link Status tab was not visible");
}

const statusText = run("agent-browser get text '#documents'").stdout;
writeArtifact("scenario-open-shared-drive-link-02-status.txt", statusText);
if (statusText.includes(SHARED_FILE_URL)) {
  pass("Status tab listed pending shared Drive URI");
} else {
  fail("Status tab did not list pending shared Drive URI");
}

const seedAuth = run(
  `agent-browser eval "(async () => {
    localStorage.setItem('${GOOGLE_AUTH_STORAGE_KEY}', JSON.stringify({
      token: 'fake-drive-access-token',
      expiresAt: ${Date.now() + 5 * 60 * 1000}
    }));
    return 'ok';
  })()"`,
).stdout.trim();

if (seedAuth.includes("ok")) {
  pass("Seeded fake Google Drive auth token");
} else {
  fail("Failed to seed fake Google Drive auth token");
}

run("agent-browser reload");
run("agent-browser wait 4500");

snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-open-shared-drive-link-03-after-reload.txt", snapshot);

const currentDocRaw = run(
  `agent-browser eval "(async () => {
    return localStorage.getItem('${CURRENT_DOC_STORAGE_KEY}') || '';
  })()"`,
).stdout.trim();
writeArtifact("scenario-open-shared-drive-link-05-current-doc.txt", currentDocRaw);
if (/local:\/\/file\//.test(currentDocRaw)) {
  pass("Persisted resolved local current notebook after reload");
} else {
  fail("Did not persist resolved local current notebook");
}

const explorerSnapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-open-shared-drive-link-04-explorer.txt", explorerSnapshot);

if (/Shared Drive Folder/i.test(explorerSnapshot)) {
  pass("Explorer shows the containing shared Drive folder");
} else {
  fail("Explorer did not show the containing shared Drive folder");
}

let expandFolderRef = firstRef(explorerSnapshot, /button "Expand folder"/i);
if (expandFolderRef) {
  run(`agent-browser click ${expandFolderRef}`);
  run("agent-browser wait 900");
  snapshot = run("agent-browser snapshot -i").stdout;
}

if (/shared-drive-notebook\.json/i.test(snapshot)) {
  pass("Explorer shows the shared notebook file");
} else {
  fail("Explorer did not show the shared notebook file");
}

const documentsText = run("agent-browser get text '#documents'").stdout;
if (/shared-drive-notebook\.json/i.test(documentsText)) {
  pass("Opened the shared notebook tab");
} else {
  fail("Shared notebook tab was not opened");
}

run("agent-browser wait 1200");
run("agent-browser record stop");
run("agent-browser close");
console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
