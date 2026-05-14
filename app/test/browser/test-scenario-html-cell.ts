import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = process.env.CUJ_FRONTEND_URL?.trim() || "http://localhost:5173";
const SCENARIO_NOTEBOOK_NAME = "scenario-html-cell.runme.md";

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-html-cell-walkthrough.webm");
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

function run(command: string): { status: number; stdout: string; stderr: string } {
  const effectiveCommand = withAgentBrowserOptions(command);
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "20000");
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
  if (timedOut && effectiveCommand.trim().startsWith("agent-browser ")) {
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

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
rmSync(join(OUTPUT_DIR, "scenario-html-cell-01-initial.txt"), { force: true });
rmSync(join(OUTPUT_DIR, "scenario-html-cell-02-opened.txt"), { force: true });
rmSync(join(OUTPUT_DIR, "scenario-html-cell-03-preview.txt"), { force: true });
rmSync(join(OUTPUT_DIR, "scenario-html-cell-03-preview.png"), { force: true });
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

const seedResult = run(
  `agent-browser eval "(async () => {
    const ln = window.app?.localNotebooks;
    if (!ln) return 'missing-local-notebooks';
    const notebook = {
      metadata: {},
      cells: [
        {
          refId: 'cell_html_author',
          kind: 2,
          languageId: 'markdown',
          value: '',
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
    localStorage.setItem('runme/openNotebooks', JSON.stringify([
      { uri: 'local://file/${SCENARIO_NOTEBOOK_NAME}', name: '${SCENARIO_NOTEBOOK_NAME}', type: 'file', children: [] }
    ]));
    localStorage.setItem('runme/currentDoc', 'local://file/${SCENARIO_NOTEBOOK_NAME}');
    return 'ok';
  })()"`,
).stdout;

if (seedResult.includes("ok")) {
  pass("Created local notebook fixture for HTML cell scenario");
} else {
  fail("Failed to create local notebook fixture for HTML cell scenario");
}

run("agent-browser reload");
run("agent-browser wait 2200");

let snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-html-cell-01-initial.txt", snapshot);

const notebookProbe = run(
  `agent-browser eval "(async () => {
    return document.getElementById('language-select-cell_html_author') ? 'ok' : 'missing-language-select';
  })()"`,
);
const notebookProbeText = `${notebookProbe.stdout}\n${notebookProbe.stderr}`.trim();
if (notebookProbe.status === 0 && notebookProbeText.includes("ok")) {
  pass("Opened notebook with editable markdown cell");
} else {
  fail("Did not find editable markdown cell for HTML scenario");
}

const htmlSource = [
  "<div style='padding: 24px; background: linear-gradient(135deg, #fef3c7, #dbeafe);'>",
  "  <svg width='320' height='120' viewBox='0 0 320 120' xmlns='http://www.w3.org/2000/svg'>",
  "    <rect x='8' y='8' width='304' height='104' rx='18' fill='#0f172a' />",
  "    <circle cx='64' cy='60' r='26' fill='#22c55e' />",
  "    <text x='112' y='68' fill='white' font-size='28' font-family='Arial, sans-serif'>Hello SVG</text>",
  "  </svg>",
  "</div>",
].join("\n");

const htmlSelectRaw = run(
  `agent-browser eval "${escapeDoubleQuotes(`(() => {
    const select = document.getElementById('language-select-cell_html_author');
    if (!(select instanceof HTMLSelectElement)) {
      return JSON.stringify({ status: 'missing-language-select' });
    }
    select.value = 'html';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const waitForHtmlEditor = () =>
      new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const tick = () => {
          const editor = document.getElementById('html-editor-cell_html_author');
          if (editor || Date.now() > deadline) {
            resolve(editor);
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });
    return waitForHtmlEditor().then((editor) =>
      JSON.stringify({ status: editor ? 'ok' : 'missing-html-editor-container' })
    );
  })()`)}"`,
);
const htmlSelectText = `${htmlSelectRaw.stdout}\n${htmlSelectRaw.stderr}`.trim();
writeArtifact("scenario-html-cell-02-opened.txt", htmlSelectText);

let htmlEditorReady = false;
try {
  const parsedOnce = JSON.parse(htmlSelectRaw.stdout.trim()) as unknown;
  const parsed = (typeof parsedOnce === "string"
    ? JSON.parse(parsedOnce)
    : parsedOnce) as { status?: string };
  htmlEditorReady = parsed.status === "ok";
} catch {
  htmlEditorReady = false;
}

if (!htmlEditorReady) {
  fail("HTML conversion/population did not complete: missing-html-editor-container");
} else {
  runWithRetry(
    `agent-browser fill 'textarea[aria-label="Editor content"]' "${escapeDoubleQuotes(htmlSource)}"`,
  );
  run("agent-browser wait 600");
}

const convertAndPopulateRaw = run(
  `agent-browser eval "${escapeDoubleQuotes(`(() => {
    const editorContainer = document.getElementById('html-editor-cell_html_author');
    if (!(editorContainer instanceof HTMLElement)) {
      return JSON.stringify({ status: 'missing-html-editor-container', srcdoc: '' });
    }
    editorContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const deadline = Date.now() + 5000;
    return new Promise((resolve) => {
      const tick = () => {
        const frame = document.querySelector('[data-testid="html-preview-frame"]');
        const rendered = document.querySelector('[data-testid="html-rendered"]');
        if ((frame && rendered) || Date.now() > deadline) {
          resolve(JSON.stringify({
            status: frame && rendered ? 'ok' : 'missing-preview',
            srcdoc: frame instanceof HTMLIFrameElement ? frame.getAttribute('srcdoc') || '' : '',
          }));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  })()`)}"`,
);
const convertAndPopulateText = `${convertAndPopulateRaw.stdout}\n${convertAndPopulateRaw.stderr}`.trim();
writeArtifact("scenario-html-cell-02-opened.txt", convertAndPopulateText);

let previewSrcdoc = "";
try {
  const parsedOnce = JSON.parse(convertAndPopulateRaw.stdout.trim()) as unknown;
  const parsed = (typeof parsedOnce === "string"
    ? JSON.parse(parsedOnce)
    : parsedOnce) as { status?: string; srcdoc?: string };
  previewSrcdoc = parsed.srcdoc ?? "";
  if (parsed.status === "ok") {
    pass("Converted markdown cell to HTML and populated inline SVG source");
  } else {
    fail(`HTML conversion/population did not complete: ${parsed.status ?? "unknown"}`);
  }
} catch {
  fail("Could not parse HTML conversion result");
}

run("agent-browser wait 1200");
run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-html-cell-03-preview.png")}`);
snapshot = run("agent-browser snapshot -i").stdout;
writeArtifact("scenario-html-cell-03-preview.txt", snapshot);

if (previewSrcdoc.includes("Hello SVG") && previewSrcdoc.includes("<svg")) {
  pass("Observed inline SVG markup in HTML preview srcdoc");
} else {
  fail("HTML preview srcdoc did not contain expected SVG markup");
}

try {
  run("agent-browser record stop");
} catch (error) {
  console.warn(`[WARN] Failed to stop agent-browser recording: ${String(error)}`);
}

if (!AGENT_BROWSER_KEEP_OPEN) {
  try {
    run("agent-browser close");
  } catch (error) {
    console.warn(`[WARN] Failed to close agent-browser session: ${String(error)}`);
  }
}

console.log(`[SUMMARY] assertions=${totalCount} passed=${passCount} failed=${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
