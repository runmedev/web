import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = "http://localhost:5173";
const SCENARIO_NOTEBOOK_NAME = "scenario-appkernel-javascript.runme.md";
const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-appkernel-javascript-walkthrough.webm");

let passCount = 0;
let failCount = 0;
let totalCount = 0;

type ProbeCell = {
  refId?: string;
  exitCode?: string;
  pid?: string;
  decodedText?: string;
};

type NotebookProbe = {
  status?: string;
  cells?: ProbeCell[];
};

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
  const line = snapshot.split("\n").find((entry) => pattern.test(entry));
  if (!line) return null;
  const legacyRef = line.match(/@[a-zA-Z0-9]+/);
  if (legacyRef) return legacyRef[0];
  const currentRef = line.match(/\[ref=([^\]]+)\]/);
  return currentRef ? currentRef[1] : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function probeNotebook(): NotebookProbe {
  const raw = run(
    `agent-browser eval "(async () => {
      const ln = window.app?.localNotebooks;
      if (!ln) return JSON.stringify({ status: 'missing-local-notebooks' });
      const rec = await ln.files.get('local://file/${SCENARIO_NOTEBOOK_NAME}');
      if (!rec) return JSON.stringify({ status: 'missing-notebook-record' });
      const doc = JSON.parse(rec.doc || '{}');
      const cells = Array.isArray(doc.cells) ? doc.cells : [];
      const decoded = cells.map((cell) => {
        const outputs = Array.isArray(cell?.outputs) ? cell.outputs : [];
        const decodedChunks = [];
        for (const output of outputs) {
          const items = Array.isArray(output?.items) ? output.items : [];
          for (const item of items) {
            const data = item?.data;
            if (typeof data === 'string' && data.length > 0) {
              try {
                decodedChunks.push(atob(data));
              } catch {}
            }
          }
        }
        const meta = cell?.metadata && typeof cell.metadata === 'object' ? cell.metadata : {};
        return {
          refId: cell?.refId || '',
          exitCode: meta['runme.dev/exitCode'] || '',
          pid: meta['runme.dev/pid'] || '',
          decodedText: decodedChunks.join('\\n'),
        };
      });
      return JSON.stringify({ status: 'ok', cells: decoded });
    })()"`,
  ).stdout.trim();

  try {
    const parsedOnce = JSON.parse(raw) as unknown;
    return (typeof parsedOnce === "string" ? JSON.parse(parsedOnce) : parsedOnce) as NotebookProbe;
  } catch {
    return { status: "parse-error" };
  }
}

function waitForNotebookProbe(
  predicate: (probe: NotebookProbe) => boolean,
  timeoutMs = 7000,
): NotebookProbe {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = probeNotebook();
    if (predicate(probe)) {
      return probe;
    }
    run("agent-browser wait 300");
  }
  return probeNotebook();
}

function setRunnerSelect(cellRefId: string, runnerName: string): boolean {
  const result = run(
    `agent-browser eval "(async () => {
      const sel = document.getElementById('runner-select-${cellRefId}');
      if (!sel) return 'missing-select';
      sel.value = '${runnerName}';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()"`,
  ).stdout.trim();
  return result.includes(runnerName);
}

function clickRun(cellRefId: string): boolean {
  const result = run(
    `agent-browser eval "(async () => {
      const btn = document.querySelector('#cell-toolbar-${cellRefId} button[aria-label^=\\\"Run\\\"]');
      if (!btn) return 'missing-run-button';
      btn.click();
      return 'ok';
    })()"`,
  ).stdout.trim();
  return result.includes("ok");
}

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const file of [
  "scenario-appkernel-javascript-01-initial.png",
  "scenario-appkernel-javascript-02-after-seed.txt",
  "scenario-appkernel-javascript-03-opened.txt",
  "scenario-appkernel-javascript-04-after-runs.txt",
  "scenario-appkernel-javascript-05-probe.json",
  "scenario-appkernel-javascript-04-after-runs.png",
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
run("agent-browser wait 3500");
run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-appkernel-javascript-01-initial.png")}`);

// Clear runner config so AppKernel execution proves it is not using a remote websocket runner.
run(
  `agent-browser eval "(async () => {
    localStorage.removeItem('runme/runners');
    localStorage.removeItem('runme/defaultRunner');
    localStorage.removeItem('aisre/runners');
    localStorage.removeItem('aisre/defaultRunner');
    return 'ok';
  })()"`,
);
run("agent-browser reload");
run("agent-browser wait 2200");

const seedResult = run(
  `agent-browser eval "(async () => {
    const ln = window.app?.localNotebooks;
    if (!ln) return 'missing-local-notebooks';
    const notebook = {
      metadata: {},
      cells: [
        {
          refId: 'cell_appkernel_a',
          kind: 2,
          languageId: 'javascript',
          value: 'console.log(\\\"appkernel hello\\\");\\\\nconsole.log(JSON.stringify({ ok: true, n: 42 }));',
          metadata: {},
          outputs: []
        },
        {
          refId: 'cell_appkernel_b',
          kind: 2,
          languageId: 'javascript',
          value: 'const nb = runme.getCurrentNotebook();\\\\nconsole.log(Boolean(nb));\\\\nconsole.log(nb ? nb.getName() : \\\"no-notebook\\\");',
          metadata: {},
          outputs: []
        },
        {
          refId: 'cell_appkernel_c',
          kind: 2,
          languageId: 'javascript',
          value: 'throw new Error(\\\"appkernel expected test error\\\");',
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
  pass("Created AppKernel scenario notebook fixture");
} else {
  fail("Failed to seed AppKernel scenario notebook fixture");
}

let snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-appkernel-javascript-02-after-seed.txt", snapshot);

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
  run("agent-browser wait 1800");
  pass("Opened AppKernel scenario notebook");
} else {
  fail("Could not find AppKernel scenario notebook in explorer");
}

snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-appkernel-javascript-03-opened.txt", snapshot);

const runnerOptions = run(
  `agent-browser eval "(async () => {
    const sel = document.getElementById('runner-select-cell_appkernel_a');
    if (!sel) return JSON.stringify([]);
    return JSON.stringify(Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent || '' })));
  })()"`,
).stdout.trim();
writeArtifact("scenario-appkernel-javascript-runner-options.json", runnerOptions);
if (/AppKernel \(browser JS\)/.test(runnerOptions)) {
  pass("Runner selector includes AppKernel (browser JS)");
} else {
  fail("Runner selector missing AppKernel (browser JS)");
}

for (const refId of ["cell_appkernel_a", "cell_appkernel_b", "cell_appkernel_c"]) {
  if (setRunnerSelect(refId, "appkernel-js")) {
    pass(`Selected AppKernel runner for ${refId}`);
  } else {
    fail(`Failed to select AppKernel runner for ${refId}`);
  }
}

if (clickRun("cell_appkernel_a")) {
  pass("Triggered Cell A execution");
} else {
  fail("Failed to trigger Cell A execution");
}
let probe = waitForNotebookProbe((p) => {
  const a = p.cells?.find((c) => c.refId === "cell_appkernel_a");
  return p.status === "ok" && !!a && a.exitCode === "0" && /appkernel hello/.test(a.decodedText ?? "");
});

const cellA = probe.cells?.find((c) => c.refId === "cell_appkernel_a");
if (probe.status === "ok" && cellA && /appkernel hello/.test(cellA.decodedText ?? "") && /"ok":true/.test(cellA.decodedText ?? "") && cellA.exitCode === "0") {
  pass("Cell A wrote stdout output and zero exit code via AppKernel");
} else {
  fail("Cell A output/exit metadata did not match expectations");
}

const backendToastCheckA = run(
  `agent-browser eval "(async () => document.body.innerText.includes('Runme backend server is not running'))()"`,
).stdout.trim();
if (!/true/i.test(backendToastCheckA)) {
  pass("AppKernel Cell A execution did not show backend runner error toast");
} else {
  fail("AppKernel Cell A execution incorrectly showed backend runner error toast");
}

if (clickRun("cell_appkernel_b")) {
  pass("Triggered Cell B execution");
} else {
  fail("Failed to trigger Cell B execution");
}
probe = waitForNotebookProbe((p) => {
  const b = p.cells?.find((c) => c.refId === "cell_appkernel_b");
  return p.status === "ok" && !!b && b.exitCode === "0" && /true/.test(b.decodedText ?? "");
});
const cellB = probe.cells?.find((c) => c.refId === "cell_appkernel_b");
if (probe.status === "ok" && cellB && /true/.test(cellB.decodedText ?? "") && new RegExp(escapeRegExp(SCENARIO_NOTEBOOK_NAME)).test(cellB.decodedText ?? "")) {
  pass("Cell B accessed runme helper and printed notebook information");
} else {
  fail("Cell B helper output did not match expectations");
}

if (clickRun("cell_appkernel_c")) {
  pass("Triggered Cell C execution");
} else {
  fail("Failed to trigger Cell C execution");
}
probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((c) => c.refId === "cell_appkernel_c");
  return p.status === "ok" && !!c && c.exitCode !== "" && c.exitCode !== "0";
});
const cellC = probe.cells?.find((c) => c.refId === "cell_appkernel_c");
if (probe.status === "ok" && cellC && /appkernel expected test error/.test(cellC.decodedText ?? "") && cellC.exitCode && cellC.exitCode !== "0") {
  pass("Cell C captured expected error and non-zero exit code");
} else {
  fail("Cell C failure path did not match expectations");
}

if (clickRun("cell_appkernel_a")) {
  pass("Triggered Cell A re-run");
} else {
  fail("Failed to trigger Cell A re-run");
}
probe = waitForNotebookProbe((p) => {
  const a = p.cells?.find((c) => c.refId === "cell_appkernel_a");
  return p.status === "ok" && !!a && a.exitCode === "0" && /appkernel hello/.test(a.decodedText ?? "");
});
const cellARerun = probe.cells?.find((c) => c.refId === "cell_appkernel_a");
if (
  probe.status === "ok" &&
  cellARerun &&
  /appkernel hello/.test(cellARerun.decodedText ?? "") &&
  !/appkernel expected test error/.test(cellARerun.decodedText ?? "")
) {
  pass("Re-running Cell A replaces stale output and does not retain Cell C error text");
} else {
  fail("Cell A re-run did not clear/replace stale outputs as expected");
}

writeArtifact("scenario-appkernel-javascript-05-probe.json", JSON.stringify(probe, null, 2));
snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-appkernel-javascript-04-after-runs.txt", snapshot);
run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-appkernel-javascript-04-after-runs.png")}`);

run("agent-browser wait 1200");
run("agent-browser record stop");
run("agent-browser close");

console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
