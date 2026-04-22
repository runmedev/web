import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CURRENT_FILE = fileURLToPath(import.meta.url);
const GENERATED_DIR = resolve(CURRENT_FILE, "..");
const TEST_DIR = GENERATED_DIR.endsWith("/.generated") || GENERATED_DIR.endsWith("\\.generated")
    ? resolve(GENERATED_DIR, "..")
    : GENERATED_DIR;
const APP_ROOT = resolve(TEST_DIR, "..", "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const OUTPUT_DIR = join(TEST_DIR, "eval-output");
const FRONTEND_URL = process.env.RUNME_EVAL_FRONTEND_URL ?? "http://localhost:5173";
const FAKE_AI_BASE_URL = process.env.RUNME_EVAL_FAKE_AI_BASE_URL ?? "http://127.0.0.1:19989";
const FAKE_AI_HEALTH_URL = `${FAKE_AI_BASE_URL}/healthz`;
const FAKE_AI_RESET_URL = `${FAKE_AI_BASE_URL}/reset`;
const AGENT_BROWSER_SESSION = process.env.AGENT_BROWSER_SESSION?.trim() ?? "";
const AGENT_BROWSER_PROFILE = process.env.AGENT_BROWSER_PROFILE?.trim() ?? "";
const AGENT_BROWSER_HEADED = (process.env.AGENT_BROWSER_HEADED ?? "false")
    .trim()
    .toLowerCase() === "true";
mkdirSync(OUTPUT_DIR, { recursive: true });
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
function withAgentBrowserOptions(command) {
    const trimmed = command.trimStart();
    if (!trimmed.startsWith("agent-browser ")) {
        return command;
    }
    const leadingWhitespace = command.slice(0, command.length - trimmed.length);
    const subcommand = trimmed.slice("agent-browser ".length);
    const args = [];
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
function run(command, timeoutMs = 30000) {
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
function runOrThrow(command, timeoutMs = 30000) {
    const result = run(command, timeoutMs);
    if (result.status !== 0) {
        throw new Error(`Command failed: ${command}\n${result.stderr}`);
    }
    return result.stdout;
}
async function fetchWithTimeout(input, timeoutMs = 15000, init) {
    return await fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
}
function isHttpReady(url) {
    return run(`curl -sf ${shellQuote(url)}`, 5000).status === 0;
}
async function waitForHttpReady(url, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isHttpReady(url)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${url}`);
}
function startService(name, command, cwd) {
    const logPath = join(OUTPUT_DIR, `${name}.log`);
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
function stopService(handle) {
    if (!handle) {
        return;
    }
    handle.process.kill("SIGTERM");
    handle.logStream.end();
}
async function ensureFrontend() {
    try {
        await waitForHttpReady(FRONTEND_URL, 3000);
        return null;
    }
    catch {
        const handle = startService("frontend", "pnpm -C app run dev -- --host 127.0.0.1 --port 5173", REPO_ROOT);
        await waitForHttpReady(FRONTEND_URL);
        return handle;
    }
}
async function ensureFakeAi() {
    try {
        await waitForHttpReady(FAKE_AI_HEALTH_URL, 3000);
        return null;
    }
    catch {
        const handle = startService("fake-ai", `go run ${shellQuote(join(REPO_ROOT, "testing", "aiservice", "main.go"))}`, REPO_ROOT);
        await waitForHttpReady(FAKE_AI_HEALTH_URL);
        return handle;
    }
}
async function resetFakeAi() {
    await fetchWithTimeout(FAKE_AI_RESET_URL, 5000, { method: "POST" });
}
function escapeForDoubleQuotes(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function evaluateJson(script, timeoutMs = 30000) {
    const executable = script.trim().startsWith("(async")
        ? script
        : `(async () => { return ${script}; })()`;
    const wrapped = `agent-browser eval "${escapeForDoubleQuotes(executable)}"`;
    const stdout = runOrThrow(wrapped, timeoutMs).trim();
    const normalized = stdout.startsWith('"') ? JSON.parse(stdout) : stdout;
    if (typeof normalized !== "string") {
        return normalized;
    }
    return JSON.parse(normalized);
}
async function bootstrapEvalBridge() {
    run("agent-browser close", 5000);
    runOrThrow(`agent-browser open ${FRONTEND_URL}`, 30000);
    run("agent-browser wait 2500", 5000);
    evaluateJson(`JSON.stringify(await window.__runmeEval.waitUntilReady())`, 30000);
}
function createNotebook(name) {
    return evaluateJson(`JSON.stringify(await window.__runmeEval.createLocalNotebook({
      name: ${JSON.stringify(name)},
      cells: [],
      open: true
    }))`, 30000);
}
function configureResponsesDirect() {
    evaluateJson(`JSON.stringify((await window.__runmeEval.configureResponsesDirect({
      authMethod: 'api_key',
      apiKey: 'test-key'
    }), true))`, 15000);
}
function runBrowserEval(options) {
    return evaluateJson(`JSON.stringify(await window.__runmeEval.run(${JSON.stringify(options)}))`, 90000);
}
function assert(ok, message) {
    return { ok, message };
}
async function runCodexProxyHelloWorldEval() {
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
        assert(result.assistantText.includes("Cell has been added."), "assistant text confirms the cell was added"),
        assert(result.requestLog.some((entry) => entry.method === "turn/start"), "request log includes turn/start"),
        assert(Boolean(result.notebook?.cells.some((cell) => cell.value.includes(`print("hello world")`))), "notebook snapshot contains the hello world cell"),
        assert(result.metrics.ttfmMs !== null, "TTFM was recorded"),
        assert(result.metrics.turnTimeMs > 0, "turn time was recorded"),
    ];
    return {
        name: "codex proxy adds hello world cell",
        status: assertions.every((item) => item.ok) ? "PASS" : "FAIL",
        assertions,
    };
}
async function runResponsesDirectHelloWorldEval() {
    await resetFakeAi();
    configureResponsesDirect();
    const notebook = createNotebook("eval-responses-direct.runme.md");
    const result = runBrowserEval({
        harness: {
            adapter: "responses-direct",
            name: "responses-direct-eval",
            baseUrl: FAKE_AI_BASE_URL,
        },
        notebookUri: notebook.uri,
        prompt: `Add a cell to print("hello world")`,
        timeoutMs: 45000,
    });
    const assertions = [
        assert(result.assistantText.includes("Cell has been added."), "assistant text confirms the cell was added"),
        assert(Boolean(result.notebook?.cells.some((cell) => cell.value.includes(`print("hello world")`))), "notebook snapshot contains the hello world cell"),
        assert(result.metrics.ttfmMs !== null, "TTFM was recorded"),
        assert(result.metrics.turnTimeMs > 0, "turn time was recorded"),
    ];
    return {
        name: "responses-direct adds hello world cell",
        status: assertions.every((item) => item.ok) ? "PASS" : "FAIL",
        assertions,
    };
}
async function main() {
    let frontendHandle = null;
    let fakeAiHandle = null;
    try {
        frontendHandle = await ensureFrontend();
        fakeAiHandle = await ensureFakeAi();
        await bootstrapEvalBridge();
        const results = [
            await runCodexProxyHelloWorldEval(),
            await runResponsesDirectHelloWorldEval(),
        ];
        let failed = 0;
        for (const result of results) {
            console.log(`${result.status} ${result.name}`);
            for (const assertion of result.assertions) {
                console.log(`  ${assertion.ok ? "PASS" : "FAIL"} ${assertion.message}`);
            }
            if (result.status === "FAIL") {
                failed += 1;
            }
        }
        if (failed > 0) {
            process.exitCode = 1;
        }
    }
    finally {
        run("agent-browser close", 5000);
        stopService(fakeAiHandle);
        stopService(frontendHandle);
    }
}
await main();
