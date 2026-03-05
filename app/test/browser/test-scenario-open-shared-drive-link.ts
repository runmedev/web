import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = "http://localhost:5173";
const FAKE_DRIVE_URL = process.env.CUJ_FAKE_DRIVE_URL?.trim() ?? "http://127.0.0.1:9090";
const SHARED_FILE_URL = "https://drive.google.com/file/d/shared-file-123/view";
const SHARED_FOLDER_URL = "https://drive.google.com/drive/folders/shared-folder-123";
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
const STATUS_SCREENSHOT = join(OUTPUT_DIR, "scenario-open-shared-drive-link-01-status-tab.png");
const FILE_LOADED_SCREENSHOT = join(OUTPUT_DIR, "scenario-open-shared-drive-link-02-file-loaded.png");
const DOCUMENT_SHARE_MENU_SCREENSHOT = join(OUTPUT_DIR, "scenario-open-shared-drive-link-03-document-share-menu.png");
const FILE_SHARE_MENU_SCREENSHOT = join(OUTPUT_DIR, "scenario-open-shared-drive-link-04-file-share-menu.png");
const FOLDER_SHARE_MENU_SCREENSHOT = join(OUTPUT_DIR, "scenario-open-shared-drive-link-05-folder-share-menu.png");
const FOLDER_LOADED_SCREENSHOT = join(OUTPUT_DIR, "scenario-open-shared-drive-link-06-folder-loaded.png");

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

function takeScreenshot(path: string): void {
  runOrThrow(`agent-browser screenshot ${path}`);
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

function openContextMenuForLabel(label: string): void {
  runOrThrow(
    `agent-browser eval "(async () => {
      const label = \\"${escapeDoubleQuotes(label)}\\";
      const explorer = document.querySelector('#workspace-explorer-box');
      if (!explorer) {
        throw new Error('Workspace explorer is not rendered');
      }
      const target =
        [...explorer.querySelectorAll('[title]')].find((node) =>
          node.getAttribute('title') === label,
        ) ||
        [...explorer.querySelectorAll('[data-node-id]')].find((node) =>
          (node.textContent || '').includes(label),
        );
      if (!target) {
        throw new Error('Unable to find explorer node for ' + label);
      }
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + Math.min(16, rect.width / 2),
        clientY: rect.top + Math.min(16, rect.height / 2),
      }));
      return 'ok';
    })()"`,
  );
  run("agent-browser wait 500");
}

function expandFolderInExplorer(label: string): void {
  runOrThrow(
    `agent-browser eval "(async () => {
      const label = \\"${escapeDoubleQuotes(label)}\\";
      const explorer = document.querySelector('#workspace-explorer-box');
      if (!explorer) {
        throw new Error('Workspace explorer is not rendered');
      }
      const titleNode = [...explorer.querySelectorAll('[title]')].find((node) =>
        node.getAttribute('title') === label,
      );
      if (!titleNode) {
        throw new Error('Unable to find folder row for ' + label);
      }
      const row = titleNode.closest('[data-node-id]');
      const toggle = [...(row?.querySelectorAll('button') || [])].find((node) =>
        node.getAttribute('aria-label') === 'Expand folder',
      );
      if (toggle) {
        toggle.click();
      }
      return 'ok';
    })()"`,
  );
  run("agent-browser wait 900");
}

function openNotebookDocumentContextMenu(): void {
  runOrThrow(
    `agent-browser eval "(async () => {
      const cell =
        document.querySelector('[data-document-id] [data-testid=\"code-action\"]') ||
        document.querySelector('[data-document-id] [data-testid=\"markdown-action\"]');
      if (!cell) {
        throw new Error('Unable to find a notebook cell to open the document context menu');
      }
      const rect = cell.getBoundingClientRect();
      cell.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + Math.min(32, rect.width / 2),
        clientY: rect.top + Math.min(24, rect.height / 2),
      }));
      return 'ok';
    })()"`,
  );
  run("agent-browser wait 500");
}

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const file of [
  "scenario-open-shared-drive-link-01-initial.txt",
  "scenario-open-shared-drive-link-02-status.txt",
  "scenario-open-shared-drive-link-03-after-reload.txt",
  "scenario-open-shared-drive-link-04-explorer.txt",
  "scenario-open-shared-drive-link-05-current-doc.txt",
  "scenario-open-shared-drive-link-06-folder-status.txt",
  "scenario-open-shared-drive-link-07-folder-explorer.txt",
]) {
  rmSync(join(OUTPUT_DIR, file), { force: true });
}
rmSync(MOVIE_PATH, { force: true });
for (const image of [
  STATUS_SCREENSHOT,
  FILE_LOADED_SCREENSHOT,
  DOCUMENT_SHARE_MENU_SCREENSHOT,
  FILE_SHARE_MENU_SCREENSHOT,
  FOLDER_SHARE_MENU_SCREENSHOT,
  FOLDER_LOADED_SCREENSHOT,
]) {
  rmSync(image, { force: true });
}

if (run("command -v agent-browser").status !== 0) {
  console.error("ERROR: agent-browser is required on PATH");
  process.exit(2);
}

if (run(`curl -sf ${FRONTEND_URL}`).status !== 0) {
  console.error(`ERROR: frontend is not running at ${FRONTEND_URL}`);
  process.exit(1);
}

runWithRetry(`agent-browser open ${FRONTEND_URL}`);
run("agent-browser record stop");
runWithRetry(`agent-browser record start ${MOVIE_PATH}`);
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
takeScreenshot(STATUS_SCREENSHOT);

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

const explorerSnapshot = run("agent-browser get text '#workspace-explorer-box'").stdout;
writeArtifact("scenario-open-shared-drive-link-04-explorer.txt", explorerSnapshot);

if (/Shared Drive Folder/i.test(explorerSnapshot)) {
  pass("Explorer shows the containing shared Drive folder");
} else {
  fail("Explorer did not show the containing shared Drive folder");
}

expandFolderInExplorer("Shared Drive Folder");
const expandedExplorerText = run("agent-browser get text '#workspace-explorer-box'").stdout;
writeArtifact("scenario-open-shared-drive-link-04-explorer.txt", expandedExplorerText);

if (/shared-drive-notebook\.json/i.test(expandedExplorerText)) {
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
takeScreenshot(FILE_LOADED_SCREENSHOT);

openNotebookDocumentContextMenu();
snapshot = run("agent-browser snapshot -i").stdout;
if (/Copy Share Link/i.test(snapshot)) {
  pass("Notebook document context menu offers a share link action");
} else {
  fail("Notebook document context menu did not offer a share link action");
}
takeScreenshot(DOCUMENT_SHARE_MENU_SCREENSHOT);

expandFolderInExplorer("Shared Drive Folder");
openContextMenuForLabel("shared-drive-notebook.json");
snapshot = run("agent-browser snapshot -i").stdout;
if (/Copy Share Link/i.test(snapshot)) {
  pass("File explorer context menu offers a share link action");
} else {
  fail("File explorer context menu did not offer a share link action");
}
takeScreenshot(FILE_SHARE_MENU_SCREENSHOT);

let copyShareRef = firstRef(snapshot, /button "Copy Share Link"/i);
if (copyShareRef) {
  run(`agent-browser click ${copyShareRef}`);
  run("agent-browser wait 400");
}
const expectedFileShareLink =
  `${FRONTEND_URL}/?doc=${encodeURIComponent(SHARED_FILE_URL)}`;
const fileShareStatus = run("agent-browser get text '#workspace-explorer-box'").stdout;
if (fileShareStatus.includes(expectedFileShareLink)) {
  pass("Copied the shared notebook app link from the file context menu");
} else {
  fail(`File share link status did not include ${expectedFileShareLink}`);
}

openContextMenuForLabel("Shared Drive Folder");
snapshot = run("agent-browser snapshot -i").stdout;
if (/Copy Share Link/i.test(snapshot)) {
  pass("Folder explorer context menu offers a share link action");
} else {
  fail("Folder explorer context menu did not offer a share link action");
}
takeScreenshot(FOLDER_SHARE_MENU_SCREENSHOT);

copyShareRef = firstRef(snapshot, /button "Copy Share Link"/i);
if (copyShareRef) {
  run(`agent-browser click ${copyShareRef}`);
  run("agent-browser wait 400");
}
const expectedFolderShareLink =
  `${FRONTEND_URL}/?doc=${encodeURIComponent(SHARED_FOLDER_URL)}`;
const folderShareStatus = run("agent-browser get text '#workspace-explorer-box'").stdout;
if (folderShareStatus.includes(expectedFolderShareLink)) {
  pass("Copied the shared folder app link from the folder context menu");
} else {
  fail(`Folder share link status did not include ${expectedFolderShareLink}`);
}

run(
  `agent-browser eval "(async () => {
    localStorage.removeItem('${GOOGLE_AUTH_STORAGE_KEY}');
    localStorage.removeItem('${CURRENT_DOC_STORAGE_KEY}');
    localStorage.setItem('${WORKSPACE_STORAGE_KEY}', JSON.stringify({ items: [] }));
    return 'ok';
  })()"`,
);
runWithRetry(`agent-browser open "${FRONTEND_URL}/?doc=${encodeURIComponent(SHARED_FOLDER_URL)}"`);
run("agent-browser wait 3000");

const folderQueuedSnapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-open-shared-drive-link-06-folder-status.txt", folderQueuedSnapshot);
if (/Drive Link Status/i.test(folderQueuedSnapshot)) {
  pass("Opened Drive Link Status tab while shared folder link is pending");
} else {
  fail("Drive Link Status tab was not visible for the shared folder link");
}

run(
  `agent-browser eval "(async () => {
    localStorage.setItem('${GOOGLE_AUTH_STORAGE_KEY}', JSON.stringify({
      token: 'fake-drive-access-token',
      expiresAt: ${Date.now() + 5 * 60 * 1000}
    }));
    return 'ok';
  })()"`,
);
run("agent-browser reload");
run("agent-browser wait 4500");

const folderExplorerSnapshot = run("agent-browser snapshot -i").stdout;
writeArtifact(
  "scenario-open-shared-drive-link-07-folder-explorer.txt",
  folderExplorerSnapshot,
);
if (/Shared Drive Folder/i.test(folderExplorerSnapshot)) {
  pass("Shared folder query links mount the folder in Explorer");
} else {
  fail("Shared folder query links did not mount the folder in Explorer");
}

expandFolderInExplorer("Shared Drive Folder");
snapshot = run("agent-browser get text '#workspace-explorer-box'").stdout;

if (/shared-drive-notebook\.json/i.test(snapshot)) {
  pass("Mounted shared folders can be expanded to show their contents");
} else {
  fail("Mounted shared folders did not show their contents");
}
takeScreenshot(FOLDER_LOADED_SCREENSHOT);

run("agent-browser wait 1200");
run("agent-browser record stop");
run("agent-browser close");
console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
