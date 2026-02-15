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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");

let passCount = 0;
let failCount = 0;
let totalCount = 0;

/**
 * Run a shell command and return captured stdout/stderr/status.
 */
function run(command: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, { shell: true, encoding: "utf-8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
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
  const match = line.match(/@[a-zA-Z0-9]+/);
  return match ? match[0] : null;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
rmSync(join(OUTPUT_DIR, "scenario-hello-world-01-initial.png"), { force: true });
for (const file of [
  "scenario-hello-world-02-after-seed.txt",
  "scenario-hello-world-03-console-output.txt",
  "scenario-hello-world-04-before-open.txt",
  "scenario-hello-world-04b-after-expand.txt",
  "scenario-hello-world-05-opened-notebook.txt",
  "scenario-hello-world-06-after-run.txt",
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
run("agent-browser wait 3500");
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
        metadata: { runner: 'local' },
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
  run("agent-browser close");
  process.exit(1);
}

run(`agent-browser click ${consoleRef}`);
run(`agent-browser type ${consoleRef} "aisreRunners.update('local','http://localhost:9977')"`);
run("agent-browser press Enter");
run("agent-browser wait 500");
run(`agent-browser type ${consoleRef} "aisreRunners.setDefault('local')"`);
run("agent-browser press Enter");
run("agent-browser wait 500");
run(`agent-browser type ${consoleRef} "aisreRunners.getDefault()"`);
run("agent-browser press Enter");
run("agent-browser wait 1000");

const consoleOutput = run("agent-browser get text '#app-console-output'").stdout;
writeArtifact("scenario-hello-world-03-console-output.txt", consoleOutput);
if (consoleOutput.includes("Default runner: local")) {
  pass("Configured local runner and set default");
} else {
  fail("Default runner output did not report local");
}

snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-hello-world-04-before-open.txt", snapshot);
let notebookRef = firstRef(snapshot, new RegExp(SCENARIO_NOTEBOOK_NAME.replace(".", "\\.")));
if (!notebookRef) {
  const localRef = firstRef(snapshot, /Local Notebooks/i);
  if (localRef) {
    run(`agent-browser click ${localRef}`);
    run("agent-browser wait 700");
    snapshot = run("agent-browser snapshot -i").stdout;
    writeArtifact("scenario-hello-world-04b-after-expand.txt", snapshot);
    notebookRef = firstRef(snapshot, new RegExp(SCENARIO_NOTEBOOK_NAME.replace(".", "\\.")));
  }
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
let runRef = firstRef(snapshot, /Run cell/i) ?? firstRef(snapshot, /\bRun\b/i);
if (runRef) {
  run(`agent-browser click ${runRef}`);
  run("agent-browser wait 3500");
  pass("Triggered cell execution");
} else {
  fail("Could not find a Run control for the first cell");
}

run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-hello-world-06-after-run.png")}`);
snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-hello-world-06-after-run.txt", snapshot);

if (/hello world/i.test(snapshot)) {
  pass("Observed hello world output in UI snapshot");
} else {
  fail("Did not observe hello world in UI snapshot");
}

run("agent-browser close");
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
