import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scrollToBottomOfNotebook,
  scrollToTopOfCell,
  waitForCellExecution,
} from "./notebook-execution.js";

const FRONTEND_URL = process.env.CUJ_FRONTEND_URL ?? "http://localhost:5173";
const BACKEND_URL = process.env.CUJ_BACKEND_URL ?? "http://localhost:9977";
const SCENARIO_NOTEBOOK_NAME = "scenario-jupyter-cuj.runme.md";
const SCENARIO_NOTEBOOK_URI = `local://file/${SCENARIO_NOTEBOOK_NAME}`;
const JUPYTER_PORT = Number(process.env.CUJ_JUPYTER_PORT ?? "18888");
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
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-jupyter-cuj-walkthrough.webm");
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

type ProbeCell = {
  refId?: string;
  lastRunID?: string;
  exitCode?: string;
  pid?: string;
  decodedText?: string;
  runnerName?: string;
  jupyterServerName?: string;
  jupyterKernelID?: string;
  jupyterKernelName?: string;
};

type NotebookProbe = {
  status?: string;
  cells?: ProbeCell[];
};

function toWsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }
    parsed.pathname = "/ws";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "ws://localhost:9977/ws";
  }
}

const BACKEND_WS = toWsUrl(BACKEND_URL);

// TODO(jlewi): This should really be shared tooling for all the scenarios.
function run(command: string): { status: number; stdout: string; stderr: string } {
  const effectiveCommand = withAgentBrowserOptions(command);
  console.log(`Running command: ${effectiveCommand}`);
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "30000");
  const maxLogChars = Number(process.env.CUJ_SCENARIO_CMD_LOG_CHARS ?? "4000");
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
  const status = result.status ?? (timedOut ? 124 : 1);
  const stdout = result.stdout ?? "";
  const stderr = `${result.stderr ?? ""}${timeoutHint}`;
  const clip = (value: string): string => {
    if (!Number.isFinite(maxLogChars) || maxLogChars <= 0 || value.length <= maxLogChars) {
      return value;
    }
    return `${value.slice(0, maxLogChars)}\n...[truncated ${value.length - maxLogChars} chars]...`;
  };
  console.log(`[run-result] status=${status} command=${effectiveCommand}`);
  if (stdout.trim()) {
    console.log(`[run-stdout]\n${clip(stdout)}`);
  }
  if (stderr.trim()) {
    console.log(`[run-stderr]\n${clip(stderr)}`);
  }
  return { status, stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function agentBrowserCommand(subcommand: string): string {  
  const parts: string[] = ["agent-browser"];
  if (AGENT_BROWSER_SESSION) {
    parts.push("--session", shellQuote(AGENT_BROWSER_SESSION));
  }
  if (AGENT_BROWSER_PROFILE) {
    parts.push("--profile", shellQuote(AGENT_BROWSER_PROFILE));
  }
  if (AGENT_BROWSER_HEADED) {
    parts.push("--headed");
  }
  parts.push(subcommand);
  return parts.join(" ");
}

function withAgentBrowserOptions(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith("agent-browser ")) {
    return command;
  }
  if (
    trimmed.startsWith("agent-browser --session ") ||
    trimmed.startsWith("agent-browser --profile ") ||
    trimmed.startsWith("agent-browser --headed ")
  ) {
    return command;
  }
  return agentBrowserCommand(trimmed.slice("agent-browser ".length));
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

function parseAgentEvalString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" ? parsed : trimmed;
  } catch {
    return trimmed;
  }
}

function evalInBrowser(script: string): string {
  const raw = run(agentBrowserCommand(`eval "${escapeDoubleQuotes(script)}"`));
  return parseAgentEvalString(`${raw.stdout}\n${raw.stderr}`.trim());
}

function waitInBrowser(ms: number): void {
  const waitMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 1;
  run(agentBrowserCommand(`wait ${waitMs}`));
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
      run(agentBrowserCommand(`wait ${waitMs}`));
    }
  }
  throw new Error(`Command failed after ${attempts} attempts: ${command}\n${lastError}`);
}

function probeNotebook(): NotebookProbe {
  const raw = run(
    agentBrowserCommand(`eval "(async () => {
      const ln = window.app?.localNotebooks;
      if (!ln) return JSON.stringify({ status: 'missing-local-notebooks' });
      const rec = await ln.files.get('${SCENARIO_NOTEBOOK_URI}');
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
              } catch {
                // ignore decode failures
              }
            }
          }
        }
        const meta = cell?.metadata && typeof cell.metadata === 'object' ? cell.metadata : {};
        const rawLastRunID = meta['runme.dev/lastRunID'];
        const rawExitCode = meta['runme.dev/exitCode'];
        const rawPID = meta['runme.dev/pid'];
        return {
          refId: cell?.refId || '',
          lastRunID: rawLastRunID === undefined || rawLastRunID === null ? '' : String(rawLastRunID),
          exitCode: rawExitCode === undefined || rawExitCode === null ? '' : String(rawExitCode),
          pid: rawPID === undefined || rawPID === null ? '' : String(rawPID),
          decodedText: decodedChunks.join('\\n'),
          runnerName: typeof meta['runme.dev/runnerName'] === 'string' ? meta['runme.dev/runnerName'] : '',
          jupyterServerName: typeof meta['runme.dev/jupyterServerName'] === 'string' ? meta['runme.dev/jupyterServerName'] : '',
          jupyterKernelID: typeof meta['runme.dev/jupyterKernelID'] === 'string' ? meta['runme.dev/jupyterKernelID'] : '',
          jupyterKernelName: typeof meta['runme.dev/jupyterKernelName'] === 'string' ? meta['runme.dev/jupyterKernelName'] : '',
        };
      });
      return JSON.stringify({ status: 'ok', cells: decoded });
    })()"`),
  ).stdout.trim();

  try {
    const parsed = JSON.parse(raw) as unknown;
    return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as NotebookProbe;
  } catch {
    return { status: "parse-error" };
  }
}

function waitForNotebookProbe(
  predicate: (probe: NotebookProbe) => boolean,
  timeoutMs = 30000,
): NotebookProbe {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = probeNotebook();
    if (predicate(probe)) {
      return probe;
    }
    run(agentBrowserCommand("wait 300"));
  }
  return probeNotebook();
}

function waitForCellExecutionCompletion(
  cellRefId: string,
  previousRunID = "",
  timeoutMs = 60000,
) {
  const result = waitForCellExecution<NotebookProbe, ProbeCell>({
    cellRefId,
    previousRunID,
    timeoutMs,
    pollMs: 300,
    expectedProbeStatus: "ok",
    probe: probeNotebook,
    wait: (ms: number) => {
      waitInBrowser(ms);
    },
  });
  if (result.ok) {
    scrollToBottomOfNotebookView();
  }
  return result;
}

function waitForRunButton(cellRefId: string, timeoutMs = 12000): boolean {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = run(
      agentBrowserCommand(`eval "(async () => {
        const runButton = document.querySelector('#cell-toolbar-${cellRefId} button[aria-label^=\\"Run\\"]');
        return runButton ? 'ok' : 'missing-run-button';
      })()"`),
    );
    const result = `${probe.stdout}\n${probe.stderr}`.trim();
    if (probe.status === 0 && result.includes("ok")) {
      return true;
    }
    run(agentBrowserCommand("wait 400"));
  }
  return false;
}

function configureNotebookFocusedLayout(attempts = 3): { ok: boolean; detail: string } {
  let lastDetail = "no-attempt";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const detail = evalInBrowser(`(async () => {
      const result = {
        appConsoleCollapsed: false,
        sidePanelCollapsed: false,
        activePanelLabel: '',
      };
      try {
        localStorage.setItem('runme.appConsoleCollapsed', 'true');
        localStorage.removeItem('aisre.appConsoleCollapsed');
      } catch {}
      try {
        localStorage.removeItem('runme.sidePanel.active');
        localStorage.removeItem('aisre.sidePanel.active');
      } catch {}

      const appConsoleCollapseButton = document.querySelector('#app-console-header button[aria-label=\"Collapse app console\"]');
      if (appConsoleCollapseButton instanceof HTMLButtonElement) {
        appConsoleCollapseButton.click();
      }

      const activePanelButton = document.querySelector(
        'button[aria-label=\"Toggle Explorer panel\"][aria-pressed=\"true\"], button[aria-label=\"Toggle ChatKit panel\"][aria-pressed=\"true\"]'
      );
      if (activePanelButton instanceof HTMLButtonElement) {
        result.activePanelLabel = activePanelButton.getAttribute('aria-label') || '';
        activePanelButton.click();
      }

      await new Promise((resolve) => setTimeout(resolve, 120));

      const appConsoleStillExpanded = Boolean(
        document.querySelector('#app-console-header button[aria-label=\"Collapse app console\"]')
      );
      const activePanelStillVisible = Boolean(
        document.querySelector(
          'button[aria-label=\"Toggle Explorer panel\"][aria-pressed=\"true\"], button[aria-label=\"Toggle ChatKit panel\"][aria-pressed=\"true\"]'
        )
      );
      result.appConsoleCollapsed = !appConsoleStillExpanded;
      result.sidePanelCollapsed = !activePanelStillVisible;
      return JSON.stringify(result);
    })()`);

    lastDetail = detail;
    try {
      const parsed = JSON.parse(detail) as {
        appConsoleCollapsed?: boolean;
        sidePanelCollapsed?: boolean;
      };
      if (parsed.appConsoleCollapsed && parsed.sidePanelCollapsed) {
        return { ok: true, detail };
      }
    } catch {
      // Retry when output is not parseable.
    }
    waitInBrowser(250);
  }
  return { ok: false, detail: lastDetail };
}

function clickRun(cellRefId: string): boolean {
  scrollCellIntoView(cellRefId);
  run(agentBrowserCommand("wait 220"));
  const result = run(
    agentBrowserCommand(`eval "(async () => {
      const btn = document.querySelector('#cell-toolbar-${cellRefId} button[aria-label^=\\"Run\\"]');
      if (!btn) return 'missing-run-button';
      btn.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      btn.click();
      return 'ok';
    })()"`),
  ).stdout.trim();
  return result.includes("ok");
}

function scrollCellIntoView(cellRefId: string): boolean {
  return scrollToTopOfCell(cellRefId, {
    evaluate: evalInBrowser,
    wait: waitInBrowser,
    settleMs: 120,
  });
}

function scrollToBottomOfNotebookView(): boolean {
  return scrollToBottomOfNotebook({
    evaluate: evalInBrowser,
    wait: waitInBrowser,
    settleMs: 120,
  });
}

function selectKernelForCell(
  cellRefId: string,
  kernelAlias: string,
  timeoutMs = 30000,
): { ok: boolean; detail: string } {
  const escapedAlias = kernelAlias.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const started = Date.now();
  let lastDetail = "no-attempt";
  while (Date.now() - started < timeoutMs) {
    scrollCellIntoView(cellRefId);
    const raw = run(
      agentBrowserCommand(`eval "(async () => {
        const select = document.getElementById('kernel-select-${cellRefId}');
        if (!select || !(select instanceof HTMLSelectElement)) {
          return 'missing-select';
        }
        const options = Array.from(select.options ?? []).map((option) => ({
          value: option.value,
          label: (option.textContent || '').trim(),
        }));
        const target = options.find((option) =>
          option.label === '${escapedAlias}' ||
          option.label.includes('${escapedAlias}')
        );
        if (!target) {
          return 'missing-option:' + options.map((option) => option.label).join('|');
        }
        if (select.value !== target.value) {
          select.value = target.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const selected = (select.selectedOptions?.[0]?.textContent || '').trim();
        return 'selected:' + selected + ':' + select.value;
      })()"`),
    );
    lastDetail = parseAgentEvalString(raw.stdout || raw.stderr || "").trim();
    if (lastDetail.startsWith("selected:")) {
      return { ok: true, detail: lastDetail };
    }
    run(agentBrowserCommand("wait 300"));
  }
  return { ok: false, detail: lastDetail };
}

function captureKernelDropdownSnapshot(
  cellRefId: string,
  screenshotName: string,
  optionsName: string,
): { ok: boolean; detail: string } {
  scrollCellIntoView(cellRefId);
  run(agentBrowserCommand("wait 200"));
  const inspect = run(
    agentBrowserCommand(`eval "(async () => {
      const select = document.getElementById('kernel-select-${cellRefId}');
      if (!select || !(select instanceof HTMLSelectElement)) {
        return JSON.stringify({ status: 'missing-select', options: [] });
      }
      const options = Array.from(select.options ?? []).map((option) => ({
        value: option.value,
        label: (option.textContent || '').trim(),
      }));
      // Force a listbox-style render so screenshot captures all visible options.
      const visibleRows = Math.max(2, Math.min(options.length, 8));
      select.size = visibleRows;
      select.style.minWidth = '320px';
      select.style.height = 'auto';
      select.focus();
      return JSON.stringify({ status: 'ok', visibleRows, options });
    })()"`),
  );
  const detail = parseAgentEvalString(`${inspect.stdout}\n${inspect.stderr}`.trim());
  writeArtifact(optionsName, detail);
  run(agentBrowserCommand(`screenshot ${join(OUTPUT_DIR, screenshotName)}`));
  // Restore normal select rendering.
  run(
    agentBrowserCommand(`eval "(async () => {
      const select = document.getElementById('kernel-select-${cellRefId}');
      if (!select || !(select instanceof HTMLSelectElement)) return 'missing-select';
      select.size = 0;
      select.style.minWidth = '';
      select.style.height = '';
      return 'ok';
    })()"`),
  );
  return { ok: inspect.status === 0, detail };
}

function getRenderedCellOutputText(cellRefId: string): string {
  const raw = run(
    agentBrowserCommand(`eval "(async () => {
      const el = document.getElementById('cell-output-${cellRefId}');
      if (!el) return '';
      const domText = el.innerText || el.textContent || '';
      if (domText && domText.trim().length > 0) {
        return domText;
      }
      const consoleEl = el.querySelector('console-view');
      const terminal = consoleEl && 'terminal' in consoleEl ? consoleEl.terminal : null;
      const active = terminal?.buffer?.active;
      if (!active) {
        return '';
      }
      const lines = [];
      for (let i = 0; i < active.length; i += 1) {
        const line = active.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        if (text && text.trim().length > 0) {
          lines.push(text);
        }
      }
      return lines.join('\\n');
    })()"`),
  ).stdout;
  return parseAgentEvalString(raw);
}

function waitForRenderedCellOutput(
  cellRefId: string,
  pattern: RegExp,
  timeoutMs = 20000,
): string {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = getRenderedCellOutputText(cellRefId);
    if (pattern.test(text)) {
      return text;
    }
    run(agentBrowserCommand("wait 300"));
  }
  return getRenderedCellOutputText(cellRefId);
}

function captureSetupDiagnostics(serverName: string): string {
  const escapedServerName = serverName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const raw = run(
    agentBrowserCommand(`eval "(async () => {
      const out = {};
      try {
        out.runnersGet = app.runners.get();
      } catch (error) {
        out.runnersGetError = String(error);
      }
      try {
        out.runnersGetDefault = app.runners.getDefault();
      } catch (error) {
        out.runnersGetDefaultError = String(error);
      }
      try {
        out.servers = await jupyter.servers.get('local');
      } catch (error) {
        out.serversError = String(error);
      }
      try {
        out.kernels = await jupyter.kernels.get('local', '${escapedServerName}');
      } catch (error) {
        out.kernelsError = String(error);
      }
      try {
        const selectA = document.getElementById('kernel-select-cell_ipy_a');
        const selectB = document.getElementById('kernel-select-cell_ipy_b');
        const readOptions = (select) => {
          if (!select || !(select instanceof HTMLSelectElement)) return [];
          return Array.from(select.options ?? []).map((option) => ({
            value: option.value,
            label: (option.textContent || '').trim(),
          }));
        };
        out.kernelSelectAOptions = readOptions(selectA);
        out.kernelSelectBOptions = readOptions(selectB);
      } catch (error) {
        out.kernelSelectError = String(error);
      }
      try {
        const setupRunButton = document.querySelector('#cell-toolbar-cell_setup_kernel button[aria-label]');
        out.setupRunButton = {
          ariaLabel: setupRunButton?.getAttribute?.('aria-label') || '',
          text: (setupRunButton?.textContent || '').trim(),
          disabled: Boolean(setupRunButton && 'disabled' in setupRunButton ? setupRunButton.disabled : false),
        };
      } catch (error) {
        out.setupRunButtonError = String(error);
      }
      return JSON.stringify(out, null, 2);
    })()"`),
  );
  return parseAgentEvalString(`${raw.stdout}\n${raw.stderr}`.trim());
}

function sleepMs(ms: number): void {
  const timeoutMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  if (timeoutMs <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeoutMs);
}

function waitForMovieFile(
  path: string,
  timeoutMs = 15000,
  pollMs = 250,
): { exists: boolean; sizeBytes: number; stable: boolean; waitedMs: number } {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() <= deadline) {
    if (existsSync(path)) {
      const sizeBytes = statSync(path).size;
      if (sizeBytes > 0) {
        if (sizeBytes === lastSize) {
          stableCount += 1;
        } else {
          stableCount = 0;
        }
        if (stableCount >= 2) {
          return {
            exists: true,
            sizeBytes,
            stable: true,
            waitedMs: Date.now() - started,
          };
        }
      }
      lastSize = sizeBytes;
    }
    sleepMs(pollMs);
  }

  const exists = existsSync(path);
  const sizeBytes = exists ? statSync(path).size : 0;
  return {
    exists,
    sizeBytes,
    stable: false,
    waitedMs: Date.now() - started,
  };
}

function finalizeAndExit(): never {
  run(agentBrowserCommand("wait 800"));
  const recordStop = run(agentBrowserCommand("record stop"));
  const recordStopOutput = `${recordStop.stdout}\n${recordStop.stderr}`.trim();
  console.log(
    `[movie-check] record-stop status=${recordStop.status} output=${JSON.stringify(recordStopOutput)}`,
  );
  if (recordStop.status === 0) {
    pass("record stop command succeeded");
  } else {
    fail(`record stop command failed with status ${recordStop.status}`);
  }
  const movieProbe = waitForMovieFile(MOVIE_PATH);
  console.log(
    `[movie-check] path=${MOVIE_PATH} exists=${movieProbe.exists} size_bytes=${movieProbe.sizeBytes} stable=${movieProbe.stable} waited_ms=${movieProbe.waitedMs}`,
  );
  if (movieProbe.exists && movieProbe.sizeBytes > 0) {
    pass(`Movie exists after record stop: ${MOVIE_PATH}`);
  } else {
    fail(`Movie missing or empty after record stop: ${MOVIE_PATH}`);
  }
  if (!AGENT_BROWSER_KEEP_OPEN) {
    console.log("Closing agent browser session...");
    run(agentBrowserCommand("close"));
  } else {
    console.log("Keeping agent browser session open as per configuration");
  }
  console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const file of [
  "scenario-jupyter-cuj-auth-existing.txt",
  "scenario-jupyter-cuj-runner-seed.txt",
  "scenario-jupyter-cuj-auth-fallback.txt",
  "scenario-jupyter-cuj-01-initial.png",
  "scenario-jupyter-cuj-01a-layout.txt",
  "scenario-jupyter-cuj-seed-result.txt",
  "scenario-jupyter-cuj-02-after-seed.txt",
  "scenario-jupyter-cuj-02a-layout-post-seed.txt",
  "scenario-jupyter-cuj-03-opened.txt",
  "scenario-jupyter-cuj-04-start-output.txt",
  "scenario-jupyter-cuj-05-sync-output.txt",
  "scenario-jupyter-cuj-06a-kernel-output.txt",
  "scenario-jupyter-cuj-06-setup-output.txt",
  "scenario-jupyter-cuj-06-setup-rendered-output.txt",
  "scenario-jupyter-cuj-06-setup-cell-probe.json",
  "scenario-jupyter-cuj-06-setup-diagnostics.json",
  "scenario-jupyter-cuj-06-setup-screenshot.png",
  "scenario-jupyter-cuj-06b-kernel-select-a.txt",
  "scenario-jupyter-cuj-06b-kernel-dropdown-a-options.txt",
  "scenario-jupyter-cuj-06b-kernel-dropdown-a.png",
  "scenario-jupyter-cuj-06c-kernel-select-b.txt",
  "scenario-jupyter-cuj-06c-kernel-dropdown-b-options.txt",
  "scenario-jupyter-cuj-06c-kernel-dropdown-b.png",
  "scenario-jupyter-cuj-07-ipy-a-output.txt",
  "scenario-jupyter-cuj-08-ipy-b-output.txt",
  "scenario-jupyter-cuj-09-stop-output.txt",
  "scenario-jupyter-cuj-10-probe.json",
]) {
  rmSync(join(OUTPUT_DIR, file), { force: true });
}
rmSync(MOVIE_PATH, { force: true });

if (run("command -v agent-browser").status !== 0) {
  console.error("ERROR: agent-browser is required on PATH");
  process.exit(2);
}

if (run("command -v jupyter").status !== 0) {
  console.error("ERROR: jupyter CLI is required on PATH for jupyter CUJ scenario");
  process.exit(1);
}
const jupyterBinResult = run("command -v jupyter");
const JUPYTER_BIN = (jupyterBinResult.stdout || "").trim().split(/\r?\n/)[0]?.trim() ?? "";
if (!JUPYTER_BIN) {
  console.error("ERROR: unable to resolve jupyter CLI path for jupyter CUJ scenario");
  process.exit(1);
}
const JUPYTER_BIN_SH = shellQuote(JUPYTER_BIN);

if (run(`curl -sf ${FRONTEND_URL}`).status !== 0) {
  console.error(`ERROR: frontend is not running at ${FRONTEND_URL}`);
  process.exit(1);
}

runWithRetry(agentBrowserCommand(`open ${FRONTEND_URL}`));
run(agentBrowserCommand("record stop"));
runWithRetry(agentBrowserCommand(`record restart ${MOVIE_PATH}`));
run(agentBrowserCommand("wait 3500"));

const runnerWsLiteral = `'${BACKEND_WS.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const runnerSeed = run(
  agentBrowserCommand(`eval "(async () => {
    let existing = [];
    try {
      const parsed = JSON.parse(localStorage.getItem('runme/runners') || '[]');
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }
    const retained = existing.filter((runner) =>
      runner &&
      typeof runner === 'object' &&
      runner.name !== 'local' &&
      runner.name !== 'default'
    );
    retained.push({ name: 'local', endpoint: ${runnerWsLiteral}, reconnect: true });
    retained.push({ name: 'default', endpoint: ${runnerWsLiteral}, reconnect: true });
    localStorage.setItem('runme/runners', JSON.stringify(retained));
    localStorage.setItem('runme/defaultRunner', 'local');
    return 'ok';
  })()"`),
);
const runnerSeedResult = `${runnerSeed.stdout}\n${runnerSeed.stderr}`.trim();
writeArtifact("scenario-jupyter-cuj-runner-seed.txt", runnerSeedResult);
if (runnerSeed.status === 0 && runnerSeedResult.includes("ok")) {
  pass("Configured local runner endpoint before executing cells");
} else {
  fail("Failed to configure local runner endpoint");
  finalizeAndExit();
}

let shouldReloadAfterConfig = true;
let usedInjectedAuth = false;

if (CUJ_ID_TOKEN) {
  const existingAuthProbe = run(
    agentBrowserCommand(`eval "(async () => {
      try {
        const raw = localStorage.getItem('oidc-auth');
        if (!raw) return JSON.stringify({ hasAuth: false });
        const parsed = JSON.parse(raw);
        const expiresAt = Number(parsed?.expires_at ?? 0);
        const hasToken = typeof parsed?.id_token === 'string' && parsed.id_token.length > 0;
        return JSON.stringify({
          hasAuth: true,
          hasToken,
          expiresAt,
          validForMs: expiresAt - Date.now(),
        });
      } catch {
        return JSON.stringify({ hasAuth: false, parseError: true });
      }
    })()"`),
  );
  const existingAuthResult = `${existingAuthProbe.stdout}\n${existingAuthProbe.stderr}`.trim();
  writeArtifact("scenario-jupyter-cuj-auth-existing.txt", existingAuthResult);

  let shouldInject = true;
  if (existingAuthProbe.status === 0) {
    try {
      const parsed = JSON.parse(parseAgentEvalString(existingAuthResult)) as {
        hasAuth?: boolean;
        hasToken?: boolean;
        expiresAt?: number;
      };
      if (parsed.hasAuth && parsed.hasToken && Number(parsed.expiresAt ?? 0) > Date.now() + 60_000) {
        shouldInject = false;
      }
    } catch {
      // Continue with injection when probe cannot be parsed.
    }
  }

  if (shouldInject) {
    const idTokenLiteral = `'${CUJ_ID_TOKEN.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    const accessTokenLiteral = `'${CUJ_ACCESS_TOKEN.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    const authSeed = run(
      agentBrowserCommand(`eval "(async () => {
        localStorage.setItem('oidc-auth', JSON.stringify({
          access_token: ${accessTokenLiteral},
          id_token: ${idTokenLiteral},
          token_type: 'Bearer',
          scope: 'openid email',
          expires_at: ${CUJ_TOKEN_EXPIRES_AT}
        }));
        return localStorage.getItem('oidc-auth') ? 'ok' : 'missing';
      })()"`),
    );
    const authSeedResult = `${authSeed.stdout}\n${authSeed.stderr}`.trim();
    writeArtifact("scenario-jupyter-cuj-auth-seed.txt", authSeedResult);
    if (authSeed.status === 0 && authSeedResult.includes("ok")) {
      pass("Injected OIDC token");
      shouldReloadAfterConfig = true;
      usedInjectedAuth = true;
    } else {
      fail("Failed to inject OIDC token");
      finalizeAndExit();
    }
  } else {
    pass("Using existing browser OIDC auth");
  }
}

if (shouldReloadAfterConfig) {
  run(agentBrowserCommand("reload"));
  run(agentBrowserCommand("wait 2200"));
}

const initialLayout = configureNotebookFocusedLayout();
writeArtifact("scenario-jupyter-cuj-01a-layout.txt", initialLayout.detail);
if (initialLayout.ok) {
  pass("Applied notebook-focused layout (app console minimized, side panel collapsed)");
} else {
  fail(`Could not fully apply notebook-focused layout (${initialLayout.detail})`);
}

run(agentBrowserCommand(`screenshot ${join(OUTPUT_DIR, "scenario-jupyter-cuj-01-initial.png")}`));

const startServerCell = [
  "python - <<'PY'",
  "import json",
  "import subprocess",
  "import sys",
  "import time",
  "",
  `jupyter_bin = ${JSON.stringify(JUPYTER_BIN)}`,
  `port = ${JUPYTER_PORT}`,
  "log_path = '/tmp/jupyter-server.log'",
  "pid_path = '/tmp/jupyter-server.pid'",
  "subprocess.run([jupyter_bin, 'server', 'stop', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)",
  "with open(log_path, 'ab', buffering=0) as log_file:",
  "    proc = subprocess.Popen(",
  "        [jupyter_bin, 'server', '--no-browser', f'--port={port}'],",
  "        stdin=subprocess.DEVNULL,",
  "        stdout=log_file,",
  "        stderr=log_file,",
  "        start_new_session=True,",
  "    )",
  "with open(pid_path, 'w', encoding='utf-8') as fh:",
  "    fh.write(str(proc.pid))",
  "",
  "for _ in range(60):",
  "    try:",
  "        servers = json.loads(subprocess.check_output([jupyter_bin, 'server', 'list', '--jsonlist'], text=True))",
  "    except Exception:",
  "        servers = []",
  "    if any((s.get('port') == port) for s in servers):",
  "        print(f'jupyter-ready {port}')",
  "        sys.exit(0)",
  "    time.sleep(1)",
  "",
  "print(f'jupyter server on port {port} did not become ready', file=sys.stderr)",
  "print('--- /tmp/jupyter-server.log ---', file=sys.stderr)",
  "try:",
  "    with open(log_path, 'r', encoding='utf-8', errors='ignore') as fh:",
  "        for line in fh.readlines()[-200:]:",
  "            print(line.rstrip('\\n'), file=sys.stderr)",
  "except Exception as exc:",
  "    print(f'failed reading log: {exc}', file=sys.stderr)",
  "sys.exit(1)",
  "PY",
].join("\n");

const syncFallbackConfigDir = OUTPUT_DIR.replace(/\\/g, "/");
const serverAlias = `port-${JUPYTER_PORT}-${Date.now()}`;
const kernelAlias = `py3-local-${Date.now()}`;

const syncServersCell = [
  "python - <<'PY'",
  "import json",
  "import os",
  "import pathlib",
  "import subprocess",
  "from urllib.parse import urlparse, urlunparse",
  "",
  `jupyter_bin = ${JSON.stringify(JUPYTER_BIN)}`,
  "candidate_config_dirs = []",
  "env_config_dir = os.environ.get('RUNME_CONFIG_DIR')",
  "if env_config_dir:",
  "    candidate_config_dirs.append(env_config_dir)",
  `candidate_config_dirs.append('${syncFallbackConfigDir}')`,
  "candidate_config_dirs.append(os.path.join(os.path.expanduser('~'), '.runme-agent'))",
  "resolved_config_dirs = []",
  "seen = set()",
  "for entry in candidate_config_dirs:",
  "    if not entry:",
  "        continue",
  "    normalized = os.path.abspath(entry)",
  "    if normalized in seen:",
  "        continue",
  "    seen.add(normalized)",
  "    resolved_config_dirs.append(normalized)",
  "",
  "servers = json.loads(subprocess.check_output([jupyter_bin, 'server', 'list', '--jsonlist'], text=True))",
  "if not servers:",
  "    raise RuntimeError('No running jupyter servers found')",
  "for server in servers:",
  "    parsed = urlparse(server['url'])",
  "    port = parsed.port or (443 if parsed.scheme == 'https' else 80)",
  `    if port != ${JUPYTER_PORT}:`,
  "        continue",
  `    name = '${serverAlias}'`,
  "    path = parsed.path or '/'",
  "    if not path.endswith('/'):",
  "        path += '/'",
  "    base_url = urlunparse((parsed.scheme, parsed.netloc, path, '', '', ''))",
  "",
  "    payload = {'runner': 'local', 'base_url': base_url}",
  "    token = server.get('token')",
  "    if token:",
  "        payload['token'] = token",
  "",
  "    for config_dir in resolved_config_dirs:",
  "        jupyter_dir = pathlib.Path(config_dir) / 'jupyter'",
  "        jupyter_dir.mkdir(parents=True, exist_ok=True)",
  `        exact = jupyter_dir / '${serverAlias}.json'`,
  "        if exact.exists():",
  "            try:",
  "                exact.unlink()",
  "            except OSError:",
  "                pass",
  `        for stale in jupyter_dir.glob('port-${JUPYTER_PORT}-*.json'):`,
  "            try:",
  "                stale.unlink()",
  "            except OSError:",
  "                pass",
  "        output_path = jupyter_dir / (name + '.json')",
  "        output_path.write_text(json.dumps(payload, indent=2) + '\\n', encoding='utf-8')",
  "        os.chmod(output_path, 0o600)",
  "        print('synced ' + name + ' -> ' + str(output_path))",
  "PY",
].join("\n");

const setupKernelCell = [
  `const selectedServerName = '${serverAlias}';`,
  `const selectedKernelAlias = '${kernelAlias}';`,
  "console.log('[setup] begin', selectedServerName, selectedKernelAlias);",
  "try {",
  `  const updateMessage = app.runners.update("local", "${BACKEND_WS}");`,
  "  console.log('[setup] app.runners.update', updateMessage);",
  "  const defaultMessage = app.runners.setDefault('local');",
  "  console.log('[setup] app.runners.setDefault', defaultMessage);",
  "  try {",
  "    const servers = await jupyter.servers.get('local');",
  "    console.log('[setup] jupyter.servers.get', JSON.stringify(servers));",
  "  } catch (serverError) {",
  "    console.error('[setup] jupyter.servers.get error', String(serverError));",
  "  }",
  "  const kernel = await jupyter.kernels.start('local', selectedServerName, {",
  "    kernelSpec: 'python3',",
  "    name: selectedKernelAlias,",
  "  });",
  "  console.log('[setup] kernel-started', JSON.stringify(kernel));",
  "  const kernels = await jupyter.kernels.get('local', selectedServerName);",
  "  console.log('[setup] jupyter.kernels.get', JSON.stringify(kernels));",
  "  console.log('kernel-ready', kernel.id, selectedServerName, selectedKernelAlias);",
  "} catch (error) {",
  "  const message = error instanceof Error ? error.message : String(error);",
  "  const stack = error instanceof Error && error.stack ? error.stack : '';",
  "  console.error('[setup] error', message);",
  "  if (stack) console.error('[setup] stack', stack);",
  "  throw error;",
  "}",
].join("\n");

const stopKernelCell = [
  `await jupyter.kernels.stop('local', '${serverAlias}', '${kernelAlias}');`,
  "console.log('kernel-stopped');",
].join("\n");

const stopServerCell = [
  "python - <<'PY'",
  "import os",
  "import signal",
  "import time",
  "",
  "pid_path = '/tmp/jupyter-server.pid'",
  "pid = None",
  "if os.path.exists(pid_path):",
  "    try:",
  "        with open(pid_path, 'r', encoding='utf-8') as fh:",
  "            value = fh.read().strip()",
  "        pid = int(value) if value else None",
  "    except Exception:",
  "        pid = None",
  "",
  "if pid:",
  "    try:",
  "        os.kill(pid, signal.SIGTERM)",
  "    except ProcessLookupError:",
  "        pid = None",
  "    except PermissionError:",
  "        pid = None",
  "",
  "if pid:",
  "    for _ in range(30):",
  "        try:",
  "            os.kill(pid, 0)",
  "        except ProcessLookupError:",
  "            pid = None",
  "            break",
  "        time.sleep(0.1)",
  "",
  "if pid:",
  "    try:",
  "        os.kill(pid, signal.SIGKILL)",
  "    except Exception:",
  "        pass",
  "",
  "print('server-stopped')",
  "PY",
].join("\n");

const notebook = {
  metadata: {},
  cells: [
    {
      refId: "cell_start_server",
      kind: 2,
      languageId: "bash",
      value: startServerCell,
      metadata: {
        "runme.dev/runnerName": "local",
      },
      outputs: [],
    },
    {
      refId: "cell_sync_servers",
      kind: 2,
      languageId: "bash",
      value: syncServersCell,
      metadata: {
        "runme.dev/runnerName": "local",
      },
      outputs: [],
    },
    {
      refId: "cell_setup_kernel",
      kind: 2,
      languageId: "javascript",
      value: setupKernelCell,
      metadata: {
        "runme.dev/runnerName": "appkernel-js",
      },
      outputs: [],
    },
    {
      refId: "cell_ipy_a",
      kind: 2,
      languageId: "jupyter",
      value: "shared_value = 42\nprint(\"set\", shared_value)",
      metadata: {
        "runme.dev/runnerName": "local",
      },
      outputs: [],
    },
    {
      refId: "cell_ipy_b",
      kind: 2,
      languageId: "jupyter",
      value: "print(\"read\", shared_value)",
      metadata: {
        "runme.dev/runnerName": "local",
      },
      outputs: [],
    },
    {
      refId: "cell_stop_kernel",
      kind: 2,
      languageId: "javascript",
      value: stopKernelCell,
      metadata: {
        "runme.dev/runnerName": "appkernel-js",
      },
      outputs: [],
    },
    {
      refId: "cell_stop_server",
      kind: 2,
      languageId: "bash",
      value: stopServerCell,
      metadata: {
        "runme.dev/runnerName": "local",
      },
      outputs: [],
    },
  ],
};

const notebookBase64 = Buffer.from(JSON.stringify(notebook), "utf-8").toString("base64");

const seedCommandResult = run(
  agentBrowserCommand(`eval "(async () => {
    const ln = window.app?.localNotebooks;
    if (!ln) return 'missing-local-notebooks';
    const notebookDoc = atob('${notebookBase64}');
    await ln.files.put({
      id: '${SCENARIO_NOTEBOOK_URI}',
      uri: '${SCENARIO_NOTEBOOK_URI}',
      name: '${SCENARIO_NOTEBOOK_NAME}',
      doc: notebookDoc,
      updatedAt: new Date().toISOString(),
      parent: 'local://folder/local',
      lastSynced: '',
      remoteId: '',
      lastRemoteChecksum: ''
    });
    localStorage.setItem('runme/openNotebooks', JSON.stringify([{ uri: '${SCENARIO_NOTEBOOK_URI}', name: '${SCENARIO_NOTEBOOK_NAME}', type: 'file', children: [] }]));
    localStorage.setItem('runme/currentDoc', '${SCENARIO_NOTEBOOK_URI}');
    return 'ok';
  })()"`),
);
const seedResult = `${seedCommandResult.stdout}\n${seedCommandResult.stderr}`;
writeArtifact("scenario-jupyter-cuj-seed-result.txt", seedResult.trim());

if (seedResult.includes("ok")) {
  pass("Seeded jupyter CUJ notebook fixture");
} else {
  fail("Failed to seed jupyter CUJ notebook fixture");
  finalizeAndExit();
}

run(agentBrowserCommand("reload"));
run(agentBrowserCommand("wait 2200"));

const postSeedLayout = configureNotebookFocusedLayout();
writeArtifact("scenario-jupyter-cuj-02a-layout-post-seed.txt", postSeedLayout.detail);
if (postSeedLayout.ok) {
  pass("Re-applied notebook-focused layout after notebook reload");
} else {
  fail(`Could not re-apply notebook-focused layout after notebook reload (${postSeedLayout.detail})`);
}

let snapshot = run(agentBrowserCommand("snapshot -i")).stdout;
writeArtifact("scenario-jupyter-cuj-02-after-seed.txt", snapshot);

if (waitForRunButton("cell_start_server")) {
  pass("Opened jupyter CUJ notebook");
} else {
  fail("Could not find jupyter CUJ notebook run controls");
  finalizeAndExit();
}

snapshot = run(agentBrowserCommand("snapshot -i")).stdout;
writeArtifact("scenario-jupyter-cuj-03-opened.txt", snapshot);

if (clickRun("cell_start_server")) {
  pass("Triggered server start bash cell");
} else {
  fail("Failed to trigger server start bash cell");
}

let probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((cell) => cell.refId === "cell_start_server");
  return p.status === "ok" && !!c && c.exitCode === "0";
}, 90000);
scrollToBottomOfNotebookView();
let startCell = probe.cells?.find((cell) => cell.refId === "cell_start_server");
writeArtifact("scenario-jupyter-cuj-04-start-output.txt", startCell?.decodedText ?? "");
if (probe.status === "ok" && startCell?.exitCode === "0") {
  pass("Server start bash cell exited successfully");
} else {
  fail("Server start bash cell failed");
  finalizeAndExit();
}

if (clickRun("cell_sync_servers")) {
  pass("Triggered server sync bash cell");
} else {
  fail("Failed to trigger server sync bash cell");
}

probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((cell) => cell.refId === "cell_sync_servers");
  return (
    p.status === "ok" &&
    !!c &&
    c.exitCode === "0" &&
    new RegExp(`synced\\s+port-${JUPYTER_PORT}`, "i").test(c.decodedText ?? "")
  );
}, 45000);
scrollToBottomOfNotebookView();
const syncCell = probe.cells?.find((cell) => cell.refId === "cell_sync_servers");
writeArtifact("scenario-jupyter-cuj-05-sync-output.txt", syncCell?.decodedText ?? "");
if (
  probe.status === "ok" &&
  syncCell?.exitCode === "0" &&
  new RegExp(`synced\\s+port-${JUPYTER_PORT}`, "i").test(syncCell.decodedText ?? "")
) {
  pass(`Server sync bash cell wrote port-${JUPYTER_PORT} config`);
} else {
  fail("Server sync bash cell did not write expected config output");
  finalizeAndExit();
}

const setupRunIDBefore = (probeNotebook().cells?.find((cell) => cell.refId === "cell_setup_kernel")?.lastRunID ?? "").trim();
if (clickRun("cell_setup_kernel")) {
  pass("Triggered AppKernel setup cell");
} else {
  fail("Failed to trigger AppKernel setup cell");
  finalizeAndExit();
}

let setupWaitResult = waitForCellExecutionCompletion("cell_setup_kernel", setupRunIDBefore, 90000);
probe = setupWaitResult.probe;
let setupCell = setupWaitResult.cell ?? probe.cells?.find((cell) => cell.refId === "cell_setup_kernel");
let setupOutputText = setupCell?.decodedText ?? "";
let setupSucceeded = (
  setupWaitResult.ok &&
  probe.status === "ok" &&
  setupCell?.exitCode === "0"
);

if (
  !setupSucceeded &&
  usedInjectedAuth &&
  /(forbidden|failed to fetch)/i.test(setupOutputText)
) {
  const authFallback = run(
    agentBrowserCommand(`eval "(async () => {
      localStorage.removeItem('oidc-auth');
      return 'ok';
    })()"`),
  );
  const authFallbackResult = `${authFallback.stdout}\n${authFallback.stderr}`.trim();
  writeArtifact("scenario-jupyter-cuj-auth-fallback.txt", authFallbackResult);
  if (authFallback.status === 0 && authFallbackResult.includes("ok")) {
    pass("Cleared seeded OIDC token after setup auth/network failure and retried setup");
    run(agentBrowserCommand("reload"));
    run(agentBrowserCommand("wait 2200"));
    const retryRunIDBefore = (probeNotebook().cells?.find((cell) => cell.refId === "cell_setup_kernel")?.lastRunID ?? "").trim();
    if (clickRun("cell_setup_kernel")) {
      pass("Retried AppKernel setup cell");
    } else {
      fail("Failed to trigger AppKernel setup retry");
      finalizeAndExit();
    }
    setupWaitResult = waitForCellExecutionCompletion("cell_setup_kernel", retryRunIDBefore, 90000);
    probe = setupWaitResult.probe;
    setupCell = setupWaitResult.cell ?? probe.cells?.find((cell) => cell.refId === "cell_setup_kernel");
    setupOutputText = setupCell?.decodedText ?? "";
    setupSucceeded = (
      setupWaitResult.ok &&
      probe.status === "ok" &&
      setupCell?.exitCode === "0"
    );
  }
}

writeArtifact("scenario-jupyter-cuj-06-setup-output.txt", setupOutputText);
writeArtifact("scenario-jupyter-cuj-06-setup-cell-probe.json", JSON.stringify(setupCell ?? {}, null, 2));
writeArtifact(
  "scenario-jupyter-cuj-06-setup-rendered-output.txt",
  getRenderedCellOutputText("cell_setup_kernel"),
);
writeArtifact("scenario-jupyter-cuj-06-setup-diagnostics.json", captureSetupDiagnostics(serverAlias));
scrollCellIntoView("cell_setup_kernel");
run(agentBrowserCommand(`screenshot ${join(OUTPUT_DIR, "scenario-jupyter-cuj-06-setup-screenshot.png")}`));
if (!setupWaitResult.ok) {
  fail(
    `AppKernel setup cell did not complete (${setupWaitResult.reason})`,
  );
  finalizeAndExit();
}

if (!/kernel-started|kernel-ready/i.test(setupOutputText)) {
  fail("AppKernel setup cell completed but did not report kernel-started/kernel-ready");
  finalizeAndExit();
}

if (setupSucceeded) {
  pass("AppKernel setup cell exited successfully");
} else {
  fail(
    `AppKernel setup cell exited unsuccessfully (status=${probe.status}, exitCode=${setupCell?.exitCode ?? ""})`,
  );
  finalizeAndExit();
}

const kernelSelectA = selectKernelForCell("cell_ipy_a", kernelAlias);
captureKernelDropdownSnapshot(
  "cell_ipy_a",
  "scenario-jupyter-cuj-06b-kernel-dropdown-a.png",
  "scenario-jupyter-cuj-06b-kernel-dropdown-a-options.txt",
);
writeArtifact("scenario-jupyter-cuj-06b-kernel-select-a.txt", kernelSelectA.detail);
if (kernelSelectA.ok) {
  pass("Selected Jupyter kernel from dropdown for cell A");
} else {
  fail(`Failed to select Jupyter kernel from dropdown for cell A (${kernelSelectA.detail})`);
  finalizeAndExit();
}

const kernelSelectB = selectKernelForCell("cell_ipy_b", kernelAlias);
captureKernelDropdownSnapshot(
  "cell_ipy_b",
  "scenario-jupyter-cuj-06c-kernel-dropdown-b.png",
  "scenario-jupyter-cuj-06c-kernel-dropdown-b-options.txt",
);
writeArtifact("scenario-jupyter-cuj-06c-kernel-select-b.txt", kernelSelectB.detail);
if (kernelSelectB.ok) {
  pass("Selected Jupyter kernel from dropdown for cell B");
} else {
  fail(`Failed to select Jupyter kernel from dropdown for cell B (${kernelSelectB.detail})`);
  finalizeAndExit();
}

probe = waitForNotebookProbe((p) => {
  const ipyA = p.cells?.find((cell) => cell.refId === "cell_ipy_a");
  const ipyB = p.cells?.find((cell) => cell.refId === "cell_ipy_b");
  return (
    p.status === "ok" &&
    !!ipyA &&
    !!ipyB &&
    ipyA.jupyterServerName === serverAlias &&
    ipyB.jupyterServerName === serverAlias &&
    /[a-f0-9-]{8,}/i.test(ipyA.jupyterKernelID ?? "") &&
    /[a-f0-9-]{8,}/i.test(ipyB.jupyterKernelID ?? "") &&
    ipyA.jupyterKernelName === kernelAlias &&
    ipyB.jupyterKernelName === kernelAlias
  );
}, 45000);
const ipyAMeta = probe.cells?.find((cell) => cell.refId === "cell_ipy_a");
const ipyBMeta = probe.cells?.find((cell) => cell.refId === "cell_ipy_b");
writeArtifact(
  "scenario-jupyter-cuj-06a-kernel-output.txt",
  JSON.stringify(
    {
      ipyA: {
        jupyterServerName: ipyAMeta?.jupyterServerName ?? "",
        jupyterKernelID: ipyAMeta?.jupyterKernelID ?? "",
        jupyterKernelName: ipyAMeta?.jupyterKernelName ?? "",
      },
      ipyB: {
        jupyterServerName: ipyBMeta?.jupyterServerName ?? "",
        jupyterKernelID: ipyBMeta?.jupyterKernelID ?? "",
        jupyterKernelName: ipyBMeta?.jupyterKernelName ?? "",
      },
    },
    null,
    2,
  ),
);
if (
  probe.status === "ok" &&
  ipyAMeta?.jupyterServerName === serverAlias &&
  ipyBMeta?.jupyterServerName === serverAlias &&
  /[a-f0-9-]{8,}/i.test(ipyAMeta?.jupyterKernelID ?? "") &&
  /[a-f0-9-]{8,}/i.test(ipyBMeta?.jupyterKernelID ?? "") &&
  ipyAMeta?.jupyterKernelName === kernelAlias &&
  ipyBMeta?.jupyterKernelName === kernelAlias
) {
  pass("Jupyter kernel selection persisted to cell metadata via dropdown");
} else {
  fail("Jupyter dropdown selection did not persist kernel metadata");
  finalizeAndExit();
}

if (clickRun("cell_ipy_a")) {
  pass("Triggered IPython cell A");
} else {
  fail("Failed to trigger IPython cell A");
}
probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((cell) => cell.refId === "cell_ipy_a");
  return p.status === "ok" && !!c && c.exitCode === "0" && /set\s+42/i.test(c.decodedText ?? "");
}, 45000);
scrollToBottomOfNotebookView();
const ipyAProbeCell = probe.cells?.find((cell) => cell.refId === "cell_ipy_a");
const ipyAOutput = ipyAProbeCell?.decodedText ?? getRenderedCellOutputText("cell_ipy_a");
writeArtifact("scenario-jupyter-cuj-07-ipy-a-output.txt", ipyAOutput);
if (/set\s+42/i.test(ipyAOutput)) {
  pass("IPython cell A output contains 'set 42'");
} else {
  fail("IPython cell A output missing 'set 42'");
  finalizeAndExit();
}

if (clickRun("cell_ipy_b")) {
  pass("Triggered IPython cell B");
} else {
  fail("Failed to trigger IPython cell B");
}
probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((cell) => cell.refId === "cell_ipy_b");
  return p.status === "ok" && !!c && c.exitCode === "0" && /read\s+42/i.test(c.decodedText ?? "");
}, 45000);
scrollToBottomOfNotebookView();
const ipyBProbeCell = probe.cells?.find((cell) => cell.refId === "cell_ipy_b");
const ipyBOutput = ipyBProbeCell?.decodedText ?? getRenderedCellOutputText("cell_ipy_b");
writeArtifact("scenario-jupyter-cuj-08-ipy-b-output.txt", ipyBOutput);
if (/read\s+42/i.test(ipyBOutput)) {
  pass("IPython cell B output contains 'read 42'");
} else {
  fail("IPython cell B output missing 'read 42'");
  finalizeAndExit();
}

if (clickRun("cell_stop_kernel")) {
  pass("Triggered kernel stop cell");
} else {
  fail("Failed to trigger kernel stop cell");
}

probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((cell) => cell.refId === "cell_stop_kernel");
  return p.status === "ok" && !!c && c.exitCode === "0";
}, 30000);
scrollToBottomOfNotebookView();
const stopKernelProbe = probe.cells?.find((cell) => cell.refId === "cell_stop_kernel");
if (probe.status === "ok" && stopKernelProbe?.exitCode === "0") {
  pass("Kernel stop cell exited successfully");
} else {
  fail("Kernel stop cell failed");
}

if (clickRun("cell_stop_server")) {
  pass("Triggered server stop bash cell");
} else {
  fail("Failed to trigger server stop bash cell");
}

probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((cell) => cell.refId === "cell_stop_server");
  return p.status === "ok" && !!c && c.exitCode === "0";
}, 45000);
scrollToBottomOfNotebookView();
const stopServerProbe = probe.cells?.find((cell) => cell.refId === "cell_stop_server");
writeArtifact("scenario-jupyter-cuj-09-stop-output.txt", stopServerProbe?.decodedText ?? "");
if (probe.status === "ok" && stopServerProbe?.exitCode === "0") {
  pass("Server stop bash cell exited successfully");
} else {
  pass("Server stop bash cell cleanup did not report a clean exit (best-effort)");
}

writeArtifact("scenario-jupyter-cuj-10-probe.json", JSON.stringify(probeNotebook(), null, 2));
finalizeAndExit();
