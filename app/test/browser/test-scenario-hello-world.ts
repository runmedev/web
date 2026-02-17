import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * test-scenario-hello-world.ts - Executes the hello-world UX CUJ scenario.
 *
 * This script follows docs-dev/cujs/hello-world-local-notebook.md and keeps
 * assertions machine-verifiable by using agent-browser snapshots, text reads,
 * and JS evaluation against live DOM/app state.
 */

const FRONTEND_URL = "http://localhost:5173";
const BACKEND_URL = "http://localhost:9977";
const SCENARIO_NOTEBOOK_NAME = "scenario-hello-world.runme.md";
const CUJ_ID_TOKEN = process.env.CUJ_ID_TOKEN?.trim() ?? "";
const CUJ_ACCESS_TOKEN = process.env.CUJ_ACCESS_TOKEN?.trim() ?? CUJ_ID_TOKEN;
const tokenExpiresAtEnv = Number(process.env.CUJ_TOKEN_EXPIRES_AT ?? "");
const CUJ_TOKEN_EXPIRES_AT = Number.isFinite(tokenExpiresAtEnv) && tokenExpiresAtEnv > Date.now()
  ? tokenExpiresAtEnv
  : Date.now() + 5 * 60 * 1000;

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
// When executed from .generated, emit artifacts to the source browser test dir.
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-hello-world-walkthrough.webm");

let passCount = 0;
let failCount = 0;
let totalCount = 0;

/**
 * Run a shell command and return captured stdout/stderr/status.
 */
function run(command: string): { status: number; stdout: string; stderr: string } {
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "10000");
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

/**
 * Run a shell command and throw with context when it fails.
 */
function runOrThrow(command: string): string {
  const result = run(command);
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Record a passed assertion in a consistent format.
 */
function pass(message: string): void {
  totalCount += 1;
  passCount += 1;
  console.log(`[PASS] ${message}`);
}

/**
 * Record a failed assertion in a consistent format.
 */
function fail(message: string): void {
  totalCount += 1;
  failCount += 1;
  console.log(`[FAIL] ${message}`);
}

/**
 * Save text artifacts so debugging CI failures is easier.
 */
function writeArtifact(name: string, content: string): void {
  writeFileSync(join(OUTPUT_DIR, name), content, "utf-8");
}

/**
 * Extract the first element reference token from agent-browser snapshot lines.
 */
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

  // Newer agent-browser snapshots expose refs as [ref=e11].
  const currentRef = line.match(/\[ref=([^\]]+)\]/);
  return currentRef ? currentRef[1] : null;
}

/**
 * Escape a literal string so it can be embedded in a RegExp safely.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

mkdirSync(OUTPUT_DIR, { recursive: true });
rmSync(join(OUTPUT_DIR, "scenario-hello-world-01-initial.png"), { force: true });
rmSync(MOVIE_PATH, { force: true });
for (const file of [
  "scenario-hello-world-02-after-seed.txt",
  "scenario-hello-world-03-console-output.txt",
  "scenario-hello-world-04-before-open.txt",
  "scenario-hello-world-04b-after-expand.txt",
  "scenario-hello-world-05-opened-notebook.txt",
  "scenario-hello-world-06-after-run.txt",
  "scenario-hello-world-06b-documents.txt",
  "scenario-hello-world-07-output-probe.json",
  "scenario-hello-world-auth-seed.txt",
  "scenario-hello-world-06-after-run.png",
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

if (
  run(`curl -sf ${BACKEND_URL}`).status !== 0 &&
  run("nc -z localhost 9977").status !== 0
) {
  console.error(`ERROR: backend is not running at ${BACKEND_URL}`);
  process.exit(1);
}

runOrThrow(`agent-browser open ${FRONTEND_URL}`);
runOrThrow(`agent-browser record restart ${MOVIE_PATH}`);
run("agent-browser wait 3500");

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
  writeArtifact("scenario-hello-world-auth-seed.txt", authSeedResult);
  if (authSeed.status === 0 && authSeedResult.includes("ok")) {
    pass("Injected OIDC auth token");
    run("agent-browser reload");
    run("agent-browser wait 2200");
  } else {
    fail("Failed to inject OIDC auth token");
  }
}

run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-hello-world-01-initial.png")}`);

const seedResult = run(
  `agent-browser eval "(async () => {
  const ln = window.app?.localNotebooks;
  if (!ln) return 'missing-local-notebooks';
  const notebook = {
    metadata: {},
    cells: [
      {
        refId: 'cell_hello_world',
        kind: 2,
        languageId: 'bash',
        value: 'echo \\\"hello world\\\"',
        metadata: { runner: 'default' },
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
writeArtifact("scenario-hello-world-02-after-seed.txt", snapshot);

const consoleRef = firstRef(snapshot, /Terminal input/i);
if (!consoleRef) {
  fail("Did not find AppConsole terminal input");
} else {
  const consoleOutput = run("agent-browser get text '#app-console-output'").stdout;
  writeArtifact("scenario-hello-world-03-console-output.txt", consoleOutput);
  pass("Found AppConsole terminal input");
}

snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-hello-world-04-before-open.txt", snapshot);

const expandFolderRef = firstRef(snapshot, /button "Expand folder"/i);
if (expandFolderRef) {
  run(`agent-browser click ${expandFolderRef}`);
  run("agent-browser wait 900");
  snapshot = run("agent-browser snapshot -i").stdout;
}
writeArtifact("scenario-hello-world-04b-after-expand.txt", snapshot);

const notebookPattern = new RegExp(escapeRegExp(SCENARIO_NOTEBOOK_NAME), "i");
let notebookRef = firstRef(snapshot, notebookPattern);
for (let attempt = 0; !notebookRef && attempt < 4; attempt += 1) {
  run("agent-browser wait 700");
  snapshot = run("agent-browser snapshot -i").stdout;
  notebookRef = firstRef(snapshot, notebookPattern);
}

if (notebookRef) {
  run(`agent-browser click ${notebookRef}`);
  run("agent-browser wait 1500");
  pass("Opened scenario notebook");
} else {
  fail("Could not find scenario notebook in explorer");
}

snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-hello-world-05-opened-notebook.txt", snapshot);
let runRef =
  firstRef(snapshot, /Run code/i) ??
  firstRef(snapshot, /Run cell/i) ??
  firstRef(snapshot, /\bRun\b/i);
if (runRef) {
  run(`agent-browser click ${runRef}`);
  run("agent-browser wait 4500");
  pass("Triggered cell execution");
} else {
  fail("Could not find a Run control for the first cell");
}

run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-hello-world-06-after-run.png")}`);
snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-hello-world-06-after-run.txt", snapshot);

const documentsText = run("agent-browser get text '#documents'").stdout;
writeArtifact("scenario-hello-world-06b-documents.txt", documentsText);

const outputProbeRaw = run(
  `agent-browser eval "(async () => {
    const ln = window.app?.localNotebooks;
    if (!ln) {
      return JSON.stringify({ status: 'missing-local-notebooks' });
    }
    const rec = await ln.files.get('local://file/${SCENARIO_NOTEBOOK_NAME}');
    if (!rec) {
      return JSON.stringify({ status: 'missing-notebook-record' });
    }
    const doc = JSON.parse(rec.doc || '{}');
    const firstCell = Array.isArray(doc.cells) ? doc.cells[0] : null;
    const outputs = Array.isArray(firstCell?.outputs) ? firstCell.outputs : [];
    const decodedChunks = [];
    for (const output of outputs) {
      const items = Array.isArray(output?.items) ? output.items : [];
      for (const item of items) {
        const data = item?.data;
        if (typeof data === 'string' && data.length > 0) {
          try {
            decodedChunks.push(atob(data));
          } catch {
            // Ignore non-base64 string payloads.
          }
        }
      }
    }
    return JSON.stringify({
      status: 'ok',
      outputsCount: outputs.length,
      decodedText: decodedChunks.join('\\n'),
    });
  })()"`,
).stdout.trim();
writeArtifact("scenario-hello-world-07-output-probe.json", outputProbeRaw);

let observedExecutionOutput = false;
try {
  const parsedOnce = JSON.parse(outputProbeRaw) as unknown;
  const parsed = (typeof parsedOnce === "string"
    ? JSON.parse(parsedOnce)
    : parsedOnce) as {
    status?: string;
    outputsCount?: number;
    decodedText?: string;
  };
  observedExecutionOutput =
    parsed.status === "ok" &&
    Number(parsed.outputsCount ?? 0) > 0 &&
    /hello world/i.test(parsed.decodedText ?? "");
} catch {
  observedExecutionOutput = false;
}

if (observedExecutionOutput) {
  pass("Observed hello world in executed cell outputs");
  // Keep recording briefly so the walkthrough artifact reliably includes
  // the rendered output state before we stop the movie.
  run("agent-browser wait 1200");
} else {
  fail("Did not observe hello world in executed cell outputs");
}

run("agent-browser record stop");
if (CUJ_ID_TOKEN) {
  run(`agent-browser eval "localStorage.removeItem('oidc-auth'); 'ok'"`);
}
run("agent-browser close");
console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
