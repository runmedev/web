import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type EvalAssertion = {
  ok: boolean;
  message: string;
};

type EvalRequestLogEntry = {
  method: string;
  timestamp?: string;
  params?: unknown;
};

type RunmeEvalResult = {
  harness: {
    name: string;
    adapter: string;
    baseUrl: string;
  };
  prompt: string;
  threadId: string | null;
  assistantText: string;
  requestLog: EvalRequestLogEntry[];
  notifications: unknown[];
  wasmJournal: unknown[];
  notebook:
    | {
        uri: string;
        name: string;
        cells: Array<{
          refId: string;
          languageId: string;
          value: string;
        }>;
      }
    | null;
  opfs: Array<{
    path: string;
    kind: "file" | "directory";
    size?: number;
  }>;
  metrics: {
    ttfmMs: number | null;
    turnTimeMs: number;
  };
};

type EvalResultSummary = {
  name: string;
  status: "PASS" | "FAIL";
  assertions: EvalAssertion[];
  result: RunmeEvalResult;
};

type ServiceHandle = {
  name: string;
  process: ChildProcess;
  logStream: ReturnType<typeof createWriteStream>;
};

type EvalArtifactManifestEntry = {
  index: number;
  name: string;
  status: "PASS" | "FAIL";
  file: string;
  harness: string;
  ttfmMs: number | null;
  turnTimeMs: number;
};

const CURRENT_FILE = fileURLToPath(import.meta.url);
const GENERATED_DIR = resolve(CURRENT_FILE, "..");
const TEST_DIR =
  GENERATED_DIR.endsWith("/.generated") ||
  GENERATED_DIR.endsWith("\\.generated")
    ? resolve(GENERATED_DIR, "..")
    : GENERATED_DIR;
const APP_ROOT = resolve(TEST_DIR, "..", "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const OUTPUT_ROOT =
  process.env.RUNME_EVAL_OUTPUT_DIR ?? join(TEST_DIR, "eval-output");
const FRONTEND_URL =
  process.env.RUNME_EVAL_FRONTEND_URL ?? "http://localhost:5174";
const EVAL_BACKEND = (process.env.RUNME_EVAL_BACKEND ?? "fake")
  .trim()
  .toLowerCase();
const FAKE_AI_BASE_URL =
  process.env.RUNME_EVAL_FAKE_AI_BASE_URL ?? "http://127.0.0.1:19989";
const FAKE_AI_HEALTH_URL = `${FAKE_AI_BASE_URL}/healthz`;
const FAKE_AI_RESET_URL = `${FAKE_AI_BASE_URL}/reset`;
const FRONTEND_PORT = new URL(FRONTEND_URL).port || "5174";
const DEFAULT_OPENAI_API_KEY_FILE =
  "/Users/jlewi/secrets/openai.org-openai-internal-project-aisre-name-oaictl-jlewi.key";
const OPENAI_API_KEY_FILE =
  process.env.RUNME_EVAL_OPENAI_API_KEY_FILE ??
  process.env.OPENAI_API_KEY_FILE ??
  DEFAULT_OPENAI_API_KEY_FILE;
const OPENAI_RESPONSES_BASE_URL =
  process.env.RUNME_EVAL_OPENAI_BASE_URL ?? "https://api.openai.com";
const OPENAI_ORGANIZATION =
  process.env.RUNME_EVAL_OPENAI_ORGANIZATION ??
  process.env.OPENAI_ORGANIZATION ??
  "";
const OPENAI_PROJECT =
  process.env.RUNME_EVAL_OPENAI_PROJECT ??
  process.env.OPENAI_PROJECT_ID ??
  process.env.OPENAI_PROJECT ??
  "";
const AGENT_BROWSER_SESSION = process.env.AGENT_BROWSER_SESSION?.trim() ?? "";
const AGENT_BROWSER_PROFILE = process.env.AGENT_BROWSER_PROFILE?.trim() ?? "";
const AGENT_BROWSER_HEADED = (process.env.AGENT_BROWSER_HEADED ?? "false")
  .trim()
  .toLowerCase() === "true";
const RUN_ID =
  process.env.RUNME_EVAL_RUN_ID?.trim() ||
  new Date().toISOString().replace(/[:.]/g, "-");
const RUN_OUTPUT_DIR = join(OUTPUT_ROOT, RUN_ID);

mkdirSync(RUN_OUTPUT_DIR, { recursive: true });

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "eval"
  );
}

function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function isLiveBackend(): boolean {
  return (
    EVAL_BACKEND === "live" ||
    EVAL_BACKEND === "openai" ||
    EVAL_BACKEND === "real"
  );
}

function resolveOpenAIApiKey(): string {
  const direct =
    process.env.RUNME_EVAL_OPENAI_API_KEY?.trim() ??
    process.env.OPENAI_API_KEY?.trim() ??
    "";
  if (direct) {
    return direct;
  }
  try {
    return readFileSync(OPENAI_API_KEY_FILE, "utf-8").trim();
  } catch {
    return "";
  }
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
  return `${leadingWhitespace}${["agent-browser", ...args].join(" ")} ${subcommand}`;
}

function run(
  command: string,
  timeoutMs = 30000,
): { status: number; stdout: string; stderr: string } {
  const effectiveCommand = withAgentBrowserOptions(command);
  const result = spawnSync(effectiveCommand, {
    shell: true,
    encoding: "utf-8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    cwd: REPO_ROOT,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runOrThrow(command: string, timeoutMs = 30000): string {
  const result = run(command, timeoutMs);
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr}`);
  }
  return result.stdout;
}

async function fetchWithTimeout(
  input: string,
  timeoutMs = 15000,
  init?: RequestInit,
): Promise<Response> {
  return await fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

function isHttpReady(url: string): boolean {
  return run(`curl -sf ${shellQuote(url)}`, 5000).status === 0;
}

async function waitForHttpReady(
  url: string,
  timeoutMs = 45000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isHttpReady(url)) {
      return;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startService(
  name: string,
  command: string,
  cwd: string,
): ServiceHandle {
  const logPath = join(RUN_OUTPUT_DIR, `${name}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  return { name, process: child, logStream };
}

function stopService(handle: ServiceHandle | null): void {
  if (!handle) {
    return;
  }
  handle.process.kill("SIGTERM");
  handle.logStream.end();
}

async function ensureFrontend(): Promise<ServiceHandle | null> {
  try {
    await waitForHttpReady(FRONTEND_URL, 3000);
    return null;
  } catch {
    const handle = startService(
      "frontend",
      `pnpm -C app run dev -- --host localhost --port ${FRONTEND_PORT}`,
      REPO_ROOT,
    );
    await waitForHttpReady(FRONTEND_URL);
    return handle;
  }
}

async function ensureFakeAi(): Promise<ServiceHandle | null> {
  if (isLiveBackend()) {
    return null;
  }
  try {
    await waitForHttpReady(FAKE_AI_HEALTH_URL, 3000);
    return null;
  } catch {
    const handle = startService(
      "fake-ai",
      `go run ${shellQuote(join(REPO_ROOT, "testing", "aiservice", "main.go"))}`,
      REPO_ROOT,
    );
    await waitForHttpReady(FAKE_AI_HEALTH_URL);
    return handle;
  }
}

async function resetFakeAi(): Promise<void> {
  if (isLiveBackend()) {
    return;
  }
  await fetchWithTimeout(FAKE_AI_RESET_URL, 5000, { method: "POST" });
}

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function evaluateJson<T>(script: string, timeoutMs = 30000): T {
  const executable = script.trim().startsWith("(async")
    ? script
    : `(async () => { return ${script}; })()`;
  const wrapped = `agent-browser eval "${escapeForDoubleQuotes(executable)}"`;
  const stdout = runOrThrow(wrapped, timeoutMs).trim();
  const normalized = stdout.startsWith('"') ? JSON.parse(stdout) : stdout;
  if (typeof normalized !== "string") {
    return normalized as T;
  }
  return JSON.parse(normalized) as T;
}

async function bootstrapEvalBridge(): Promise<void> {
  run("agent-browser close", 5000);
  runOrThrow(`agent-browser open ${FRONTEND_URL}`, 30000);
  run("agent-browser wait 2500", 5000);
  evaluateJson<boolean>(
    `JSON.stringify(await window.__runmeEval.waitUntilReady())`,
    30000,
  );
}

function createNotebook(name: string): { uri: string } {
  return evaluateJson<{ uri: string }>(
    `JSON.stringify(await window.__runmeEval.createLocalNotebook({
      name: ${JSON.stringify(name)},
      cells: [],
      open: true
    }))`,
    30000,
  );
}

function configureResponsesDirect(options?: {
  authMethod?: "oauth" | "api_key";
  apiKey?: string;
  openaiOrganization?: string;
  openaiProject?: string;
}): void {
  evaluateJson<boolean>(
    `JSON.stringify((await window.__runmeEval.configureResponsesDirect({
      authMethod: ${JSON.stringify(options?.authMethod ?? "api_key")},
      apiKey: ${JSON.stringify(options?.apiKey ?? "test-key")},
      openaiOrganization: ${JSON.stringify(options?.openaiOrganization ?? "")},
      openaiProject: ${JSON.stringify(options?.openaiProject ?? "")}
    }), true))`,
    15000,
  );
}

function runBrowserEval(options: Record<string, unknown>): RunmeEvalResult {
  return evaluateJson<RunmeEvalResult>(
    `JSON.stringify(await window.__runmeEval.run(${JSON.stringify(options)}))`,
    90000,
  );
}

function assert(ok: boolean, message: string): EvalAssertion {
  return { ok, message };
}

function writeEvalArtifact(
  index: number,
  summary: EvalResultSummary,
): EvalArtifactManifestEntry {
  const filename = `${String(index + 1).padStart(2, "0")}-${slugify(summary.name)}.json`;
  writeJsonFile(join(RUN_OUTPUT_DIR, filename), {
    schemaVersion: 1,
    runId: RUN_ID,
    createdAt: new Date().toISOString(),
    backend: EVAL_BACKEND,
    frontendUrl: FRONTEND_URL,
    eval: {
      index,
      name: summary.name,
      status: summary.status,
      assertions: summary.assertions,
    },
    result: summary.result,
  });
  return {
    index,
    name: summary.name,
    status: summary.status,
    file: filename,
    harness: summary.result.harness.adapter,
    ttfmMs: summary.result.metrics.ttfmMs,
    turnTimeMs: summary.result.metrics.turnTimeMs,
  };
}

async function runCodexProxyHelloWorldEval(): Promise<EvalResultSummary> {
  await resetFakeAi();
  const notebook = createNotebook("eval-codex-proxy.runme.md");
  const result = runBrowserEval({
    harness: {
      adapter: "codex",
      name: "codex-proxy-eval",
      baseUrl: FAKE_AI_BASE_URL,
    },
    notebookUri: notebook.uri,
    prompt: `Add a cell to print("hello world")`,
    timeoutMs: 45000,
  });
  const assertions = [
    assert(
      result.assistantText.includes("Cell has been added."),
      "assistant text confirms the cell was added",
    ),
    assert(
      result.requestLog.some((entry) => entry.method === "turn/start"),
      "request log includes turn/start",
    ),
    assert(
      Boolean(
        result.notebook?.cells.some((cell) =>
          cell.value.includes(`print("hello world")`),
        ),
      ),
      "notebook snapshot contains the hello world cell",
    ),
    assert(result.metrics.ttfmMs !== null, "TTFM was recorded"),
    assert(result.metrics.turnTimeMs > 0, "turn time was recorded"),
  ];
  return {
    name: "codex proxy adds hello world cell",
    status: assertions.every((item) => item.ok) ? "PASS" : "FAIL",
    assertions,
    result,
  };
}

async function runResponsesDirectHelloWorldEval(): Promise<EvalResultSummary> {
  await resetFakeAi();
  const apiKey = isLiveBackend() ? resolveOpenAIApiKey() : "test-key";
  if (isLiveBackend() && !apiKey) {
    throw new Error(
      `RUNME_EVAL_BACKEND=live requires an API key. Set OPENAI_API_KEY or place it in ${OPENAI_API_KEY_FILE}.`,
    );
  }
  configureResponsesDirect({
    authMethod: "api_key",
    apiKey,
    openaiOrganization: OPENAI_ORGANIZATION,
    openaiProject: OPENAI_PROJECT,
  });
  const notebook = createNotebook("eval-responses-direct.runme.md");
  const result = runBrowserEval({
    harness: {
      adapter: "responses-direct",
      name: "responses-direct-eval",
      baseUrl: isLiveBackend() ? OPENAI_RESPONSES_BASE_URL : FAKE_AI_BASE_URL,
    },
    notebookUri: notebook.uri,
    prompt: `Add a cell to print("hello world")`,
    timeoutMs: 45000,
  });
  const assertions = [
    assert(
      isLiveBackend()
        ? result.assistantText.trim().length > 0
        : result.assistantText.includes("Cell has been added."),
      isLiveBackend()
        ? "assistant text was emitted"
        : "assistant text confirms the cell was added",
    ),
    assert(
      Boolean(
        result.notebook?.cells.some((cell) =>
          cell.value.includes(`print("hello world")`),
        ),
      ),
      "notebook snapshot contains the hello world cell",
    ),
    assert(result.metrics.ttfmMs !== null, "TTFM was recorded"),
    assert(result.metrics.turnTimeMs > 0, "turn time was recorded"),
  ];
  return {
    name: `${isLiveBackend() ? "responses-direct live" : "responses-direct"} adds hello world cell`,
    status: assertions.every((item) => item.ok) ? "PASS" : "FAIL",
    assertions,
    result,
  };
}

async function runCodexWasmHelloWorldEval(): Promise<EvalResultSummary> {
  const apiKey = resolveOpenAIApiKey();
  if (!apiKey) {
    throw new Error(
      `RUNME_EVAL_BACKEND=live requires an API key. Set OPENAI_API_KEY or place it in ${OPENAI_API_KEY_FILE}.`,
    );
  }
  configureResponsesDirect({
    authMethod: "api_key",
    apiKey,
    openaiOrganization: OPENAI_ORGANIZATION,
    openaiProject: OPENAI_PROJECT,
  });
  const notebook = createNotebook("eval-codex-wasm.runme.md");
  const result = runBrowserEval({
    harness: {
      adapter: "codex-wasm",
      name: "codex-wasm-eval",
    },
    notebookUri: notebook.uri,
    prompt: `Add a cell to print("hello world")`,
    timeoutMs: 90000,
    wasmApiKey: apiKey,
  });
  const assertions = [
    assert(result.assistantText.length > 0, "assistant text was emitted"),
    assert(
      Boolean(
        result.notebook?.cells.some((cell) => cell.value.includes(`hello world`)),
      ),
      "notebook snapshot contains the hello world cell",
    ),
    assert(result.metrics.ttfmMs !== null, "TTFM was recorded"),
    assert(result.metrics.turnTimeMs > 0, "turn time was recorded"),
    assert(result.wasmJournal.length > 0, "wasm journal captured activity"),
  ];
  return {
    name: "codex-wasm live adds hello world cell",
    status: assertions.every((item) => item.ok) ? "PASS" : "FAIL",
    assertions,
    result,
  };
}

async function main(): Promise<void> {
  let frontendHandle: ServiceHandle | null = null;
  let fakeAiHandle: ServiceHandle | null = null;
  try {
    frontendHandle = await ensureFrontend();
    fakeAiHandle = await ensureFakeAi();
    await bootstrapEvalBridge();

    const results = isLiveBackend()
      ? [
          await runResponsesDirectHelloWorldEval(),
          await runCodexWasmHelloWorldEval(),
        ]
      : [
          await runCodexProxyHelloWorldEval(),
          await runResponsesDirectHelloWorldEval(),
        ];

    let failed = 0;
    const manifestEntries = results.map((result, index) =>
      writeEvalArtifact(index, result),
    );
    writeJsonFile(join(RUN_OUTPUT_DIR, "summary.json"), {
      schemaVersion: 1,
      runId: RUN_ID,
      createdAt: new Date().toISOString(),
      backend: EVAL_BACKEND,
      frontendUrl: FRONTEND_URL,
      outputDir: RUN_OUTPUT_DIR,
      evals: manifestEntries,
    });

    for (const result of results) {
      console.log(`${result.status} ${result.name}`);
      for (const assertion of result.assertions) {
        console.log(`  ${assertion.ok ? "PASS" : "FAIL"} ${assertion.message}`);
      }
      console.log(
        `  metrics ttfmMs=${result.result.metrics.ttfmMs ?? "null"} turnTimeMs=${result.result.metrics.turnTimeMs}`,
      );
      if (result.status === "FAIL") {
        failed += 1;
      }
    }
    console.log(`Artifacts written to ${RUN_OUTPUT_DIR}`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    run("agent-browser close", 5000);
    stopService(fakeAiHandle);
    stopService(frontendHandle);
  }
}

await main();
