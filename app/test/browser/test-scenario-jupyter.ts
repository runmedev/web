import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const AGENT_BROWSER_SESSION = process.env.CUJ_AGENT_BROWSER_SESSION?.trim() ?? "";
const AGENT_BROWSER_PROFILE = process.env.CUJ_AGENT_BROWSER_PROFILE?.trim() ?? "";
const AGENT_BROWSER_HEADED = (process.env.CUJ_AGENT_BROWSER_HEADED ?? "false")
  .trim()
  .toLowerCase() === "true";
const AGENT_BROWSER_KEEP_OPEN = (process.env.CUJ_AGENT_BROWSER_KEEP_OPEN ?? "false")
  .trim()
  .toLowerCase() === "true";

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

function run(command: string): { status: number; stdout: string; stderr: string } {
  const effectiveCommand = withAgentBrowserOptions(command);
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "30000");
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
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${timeoutHint}`,
  };
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
        const rawExitCode = meta['runme.dev/exitCode'];
        const rawPID = meta['runme.dev/pid'];
        return {
          refId: cell?.refId || '',
          exitCode: rawExitCode === undefined || rawExitCode === null ? '' : String(rawExitCode),
          pid: rawPID === undefined || rawPID === null ? '' : String(rawPID),
          decodedText: decodedChunks.join('\\n'),
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

function clickRun(cellRefId: string): boolean {
  const result = run(
    agentBrowserCommand(`eval "(async () => {
      const btn = document.querySelector('#cell-toolbar-${cellRefId} button[aria-label^=\\"Run\\"]');
      if (!btn) return 'missing-run-button';
      btn.click();
      return 'ok';
    })()"`),
  ).stdout.trim();
  return result.includes("ok");
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

function finalizeAndExit(): never {
  run(agentBrowserCommand("wait 800"));
  run(agentBrowserCommand("record stop"));
  if (!AGENT_BROWSER_KEEP_OPEN) {
    run(agentBrowserCommand("close"));
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
  "scenario-jupyter-cuj-seed-result.txt",
  "scenario-jupyter-cuj-02-after-seed.txt",
  "scenario-jupyter-cuj-03-opened.txt",
  "scenario-jupyter-cuj-04-start-output.txt",
  "scenario-jupyter-cuj-05-sync-output.txt",
  "scenario-jupyter-cuj-06-setup-output.txt",
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

const backendWsLiteral = `'${BACKEND_WS.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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
    retained.push({ name: 'local', endpoint: ${backendWsLiteral}, reconnect: true });
    retained.push({ name: 'default', endpoint: ${backendWsLiteral}, reconnect: true });
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
  `console.log(app.runners.update("local", "${BACKEND_WS}"));`,
  'console.log(app.runners.setDefault("local"));',
  "const isTransientKernelError = (message) => /(not found|failed to fetch|networkerror|econnrefused|load failed)/i.test(message);",
  "let servers;",
  "for (let attempt = 1; attempt <= 30; attempt += 1) {",
  "  try {",
  "    servers = await jupyter.servers.get('local');",
  "    break;",
  "  } catch (err) {",
  "    const message = String(err && typeof err === 'object' && 'message' in err ? err.message : err);",
  "    if (!isTransientKernelError(message) || attempt === 30) throw err;",
  "    console.log('servers-list-retry', attempt, message);",
  "    await new Promise((resolve) => setTimeout(resolve, 1000));",
  "  }",
  "}",
  "console.log(JSON.stringify(servers));",
  `const selectedServerName = '${serverAlias}';`,
  "console.log('selected-server', selectedServerName);",
  "for (let attempt = 1; attempt <= 30; attempt += 1) {",
  "  try {",
    "    await jupyter.kernels.get('local', selectedServerName);",
    "    break;",
  "  } catch (err) {",
    "    const message = String(err && typeof err === 'object' && 'message' in err ? err.message : err);",
    "    if (!isTransientKernelError(message) || attempt === 30) throw err;",
    "    console.log('server-alias-wait', attempt, message);",
    "    await new Promise((resolve) => setTimeout(resolve, 1000));",
  "  }",
  "}",
  "let kernel;",
  "for (let attempt = 1; attempt <= 15; attempt += 1) {",
  "  try {",
  "    kernel = await jupyter.kernels.start('local', selectedServerName, { kernelSpec: 'python3', name: 'py3-local-1' });",
  "    break;",
  "  } catch (err) {",
  "    const message = String(err && typeof err === 'object' && 'message' in err ? err.message : err);",
  "    if (!isTransientKernelError(message) || attempt === 15) throw err;",
  "    console.log('kernel-start-retry', attempt, message);",
  "    await new Promise((resolve) => setTimeout(resolve, 1000));",
  "  }",
  "}",
  "if (!kernel) throw new Error('Failed to start kernel');",
  "console.log('kernel-ready', kernel.id);",
  "const nb = runme.getCurrentNotebook();",
  "for (const id of ['cell_ipy_a', 'cell_ipy_b']) {",
  "  const c = nb.getCell(id);",
  "  if (!c || !c.snapshot) continue;",
  "  const updated = structuredClone(c.snapshot);",
  "  updated.metadata = {",
  "    ...(updated.metadata || {}),",
  "    'runme.dev/runnerName': 'local',",
  "    'runme.dev/jupyterServerName': selectedServerName,",
  "    'runme.dev/jupyterKernelID': kernel.id,",
  "    'runme.dev/jupyterKernelName': 'py3-local-1',",
  "  };",
  "  nb.updateCell(updated);",
  "}",
].join("\n");

const stopKernelCell = [
  "const nb = runme.getCurrentNotebook();",
  "const c = nb.getCell('cell_ipy_a');",
  "const metadata = c?.snapshot?.metadata || {};",
  "const serverName = metadata['runme.dev/jupyterServerName'];",
  "if (!serverName || typeof serverName !== 'string') throw new Error('Missing jupyter server name metadata');",
  "await jupyter.kernels.stop('local', serverName, 'py3-local-1');",
  "console.log('kernel-stopped');",
].join("\n");

const stopServerCell = `${JUPYTER_BIN_SH} server stop ${JUPYTER_PORT}`;

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

if (clickRun("cell_setup_kernel")) {
  pass("Triggered AppKernel setup cell");
} else {
  fail("Failed to trigger AppKernel setup cell");
}

probe = waitForNotebookProbe((p) => {
  const c = p.cells?.find((cell) => cell.refId === "cell_setup_kernel");
  return p.status === "ok" && !!c && c.exitCode === "0" && /kernel-ready\s+[a-f0-9-]+/i.test(c.decodedText ?? "");
}, 45000);
let setupCell = probe.cells?.find((cell) => cell.refId === "cell_setup_kernel");
let setupOutputText = setupCell?.decodedText ?? "";
let setupSucceeded = (
  probe.status === "ok" &&
  setupCell?.exitCode === "0" &&
  /kernel-ready\s+[a-f0-9-]+/i.test(setupOutputText)
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
    if (clickRun("cell_setup_kernel")) {
      pass("Retried AppKernel setup cell");
    } else {
      fail("Failed to trigger AppKernel setup retry");
      finalizeAndExit();
    }
    probe = waitForNotebookProbe((p) => {
      const c = p.cells?.find((cell) => cell.refId === "cell_setup_kernel");
      return p.status === "ok" && !!c && c.exitCode === "0" && /kernel-ready\s+[a-f0-9-]+/i.test(c.decodedText ?? "");
    }, 45000);
    setupCell = probe.cells?.find((cell) => cell.refId === "cell_setup_kernel");
    setupOutputText = setupCell?.decodedText ?? "";
    setupSucceeded = (
      probe.status === "ok" &&
      setupCell?.exitCode === "0" &&
      /kernel-ready\s+[a-f0-9-]+/i.test(setupOutputText)
    );
  }
}

writeArtifact("scenario-jupyter-cuj-06-setup-output.txt", setupOutputText);
if (setupSucceeded) {
  pass("AppKernel setup cell started kernel and bound IPython cells");
} else {
  fail("AppKernel setup cell did not produce expected kernel-ready output");
  finalizeAndExit();
}

if (clickRun("cell_ipy_a")) {
  pass("Triggered IPython cell A");
} else {
  fail("Failed to trigger IPython cell A");
}
const ipyAOutput = waitForRenderedCellOutput("cell_ipy_a", /set\s+42/i, 45000);
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
const ipyBOutput = waitForRenderedCellOutput("cell_ipy_b", /read\s+42/i, 45000);
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
const stopServerProbe = probe.cells?.find((cell) => cell.refId === "cell_stop_server");
writeArtifact("scenario-jupyter-cuj-09-stop-output.txt", stopServerProbe?.decodedText ?? "");
if (probe.status === "ok" && stopServerProbe?.exitCode === "0") {
  pass("Server stop bash cell exited successfully");
} else {
  fail("Server stop bash cell failed");
}

writeArtifact("scenario-jupyter-cuj-10-probe.json", JSON.stringify(probeNotebook(), null, 2));
finalizeAndExit();
