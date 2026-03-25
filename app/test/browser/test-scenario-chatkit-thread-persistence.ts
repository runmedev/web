import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = process.env.CUJ_FRONTEND_URL ?? "http://localhost:5173";
const CUJ_ID_TOKEN = process.env.CUJ_ID_TOKEN?.trim() ?? "";
const CUJ_ACCESS_TOKEN = process.env.CUJ_ACCESS_TOKEN?.trim() ?? CUJ_ID_TOKEN;
const tokenExpiresAtEnv = Number(process.env.CUJ_TOKEN_EXPIRES_AT ?? "");
const CUJ_TOKEN_EXPIRES_AT = Number.isFinite(tokenExpiresAtEnv) && tokenExpiresAtEnv > Date.now()
  ? tokenExpiresAtEnv
  : Date.now() + 5 * 60 * 1000;
const FAKE_CHATKIT_BASE_URL = process.env.CUJ_FAKE_CHATKIT_BASE_URL ?? "http://127.0.0.1:19989";
const FAKE_CHATKIT_HEALTH_URL = process.env.CUJ_FAKE_CHATKIT_HEALTH_URL ?? `${FAKE_CHATKIT_BASE_URL}/healthz`;
const FAKE_CHATKIT_RESET_URL = process.env.CUJ_FAKE_CHATKIT_RESET_URL ?? `${FAKE_CHATKIT_BASE_URL}/reset`;
const DRAFT_TEXT = "draft persists across side panel tab switches";

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-chatkit-thread-persistence-walkthrough.webm");
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
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "10000");
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
  const legacyRef = line.match(/@[a-zA-Z0-9]+/);
  if (legacyRef) {
    return legacyRef[0];
  }
  const currentRef = line.match(/\[ref=([^\]]+)\]/);
  return currentRef ? currentRef[1] : null;
}

function normalizeAgentBrowserString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // keep raw text
  }
  return trimmed;
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppConsoleCommand(consoleRef: string, command: string): string {
  run(`agent-browser click ${consoleRef}`);
  run(`agent-browser type ${consoleRef} "${escapeDoubleQuotes(command)}"`);
  run("agent-browser press Enter");
  run("agent-browser wait 900");
  return normalizeAgentBrowserString(run("agent-browser get text '#app-console-output'").stdout);
}

function readHarnessStorage(): string {
  const script = "localStorage.getItem('runme/harness') || '{}'";
  return normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout,
  );
}

function resetFakeChatkitRequests(): boolean {
  const result = run(`curl -sf -X POST ${FAKE_CHATKIT_RESET_URL}`);
  return result.status === 0;
}

function setComposerValue(value: string): string {
  const script = `(() => {
    const collectRoots = () => {
      const roots = [];
      const seen = new Set();
      const visit = (root) => {
        if (!root || seen.has(root)) return;
        seen.add(root);
        roots.push(root);
        if (typeof root.querySelectorAll !== 'function') return;
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el && el.shadowRoot) visit(el.shadowRoot);
        }
      };
      const chat = document.querySelector('openai-chatkit');
      if (chat && chat.shadowRoot) {
        visit(chat.shadowRoot);
      }
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const doc = frame.contentDocument;
          if (doc) visit(doc);
        } catch {}
      }
      visit(document);
      return roots;
    };
    for (const root of collectRoots()) {
      const composer = root.querySelector('textarea') ||
        root.querySelector('[contenteditable="true"][role="textbox"]') ||
        root.querySelector('[contenteditable="true"]');
      if (!composer) continue;
      if (composer instanceof HTMLTextAreaElement) {
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (descriptor?.set) descriptor.set.call(composer, ${JSON.stringify(value)});
        else composer.value = ${JSON.stringify(value)};
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        composer.textContent = ${JSON.stringify(value)};
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return 'typed';
    }
    return 'missing-composer';
  })()`;
  return normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout,
  );
}

function readComposerValue(): string {
  const script = `(() => {
    const collectRoots = () => {
      const roots = [];
      const seen = new Set();
      const visit = (root) => {
        if (!root || seen.has(root)) return;
        seen.add(root);
        roots.push(root);
        if (typeof root.querySelectorAll !== 'function') return;
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el && el.shadowRoot) visit(el.shadowRoot);
        }
      };
      const chat = document.querySelector('openai-chatkit');
      if (chat && chat.shadowRoot) {
        visit(chat.shadowRoot);
      }
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const doc = frame.contentDocument;
          if (doc) visit(doc);
        } catch {}
      }
      visit(document);
      return roots;
    };
    for (const root of collectRoots()) {
      const composer = root.querySelector('textarea') ||
        root.querySelector('[contenteditable="true"][role="textbox"]') ||
        root.querySelector('[contenteditable="true"]');
      if (!composer) continue;
      if (composer instanceof HTMLTextAreaElement) {
        return composer.value || '';
      }
      return composer.textContent || '';
    }
    return '__missing_composer__';
  })()`;
  return normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout,
  );
}

function waitForComposer(timeoutMs = 15000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readComposerValue();
    if (current !== "__missing_composer__") {
      return true;
    }
    run("agent-browser wait 400");
  }
  return false;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
rmSync(MOVIE_PATH, { force: true });
for (const file of [
  "scenario-chatkit-thread-persistence-01-snapshot.txt",
  "scenario-chatkit-thread-persistence-02-harness.txt",
  "scenario-chatkit-thread-persistence-03-before-switch.png",
  "scenario-chatkit-thread-persistence-04-explorer.png",
  "scenario-chatkit-thread-persistence-05-after-return.png",
  "scenario-chatkit-thread-persistence-06-after-return-snapshot.txt",
  "scenario-chatkit-thread-persistence-07-composer-values.json",
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

if (run(`curl -sf ${FAKE_CHATKIT_HEALTH_URL}`).status === 0) {
  pass(`AI service is healthy at ${FAKE_CHATKIT_HEALTH_URL}`);
} else {
  fail(`AI service is not reachable at ${FAKE_CHATKIT_HEALTH_URL}`);
}

if (resetFakeChatkitRequests()) {
  pass("Reset AI service request state");
} else {
  fail("Failed to reset AI service request state");
}

let startedRecording = false;

try {
  runOrThrow(`agent-browser open ${FRONTEND_URL}`);
  runOrThrow(`agent-browser record restart ${MOVIE_PATH}`);
  startedRecording = true;
  run("agent-browser wait 2200");

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
    if (authSeed.status === 0 && authSeed.stdout.includes("ok")) {
      pass("Injected OIDC auth token");
      run("agent-browser reload");
      run("agent-browser wait 2200");
    } else {
      fail("Failed to inject OIDC auth token");
    }
  }

  const initialSnapshot = run("agent-browser snapshot").stdout;
  writeArtifact("scenario-chatkit-thread-persistence-01-snapshot.txt", initialSnapshot);

  const chatRef = firstRef(initialSnapshot, /AI Chat|ChatKit panel|Toggle ChatKit panel/i);
  const explorerRef = firstRef(
    initialSnapshot,
    /File Explorer|Explorer panel|Toggle Explorer panel/i,
  );
  const consoleRef = firstRef(initialSnapshot, /console-input|terminal input/i);

  if (!chatRef) {
    fail("Could not find AI Chat button in side panel");
  }
  if (!explorerRef) {
    fail("Could not find Explorer button in side panel");
  }
  if (!consoleRef) {
    fail("Could not find AppConsole terminal input");
  }

  if (consoleRef) {
    runAppConsoleCommand(
      consoleRef,
      `app.harness.update("fake", "${FAKE_CHATKIT_BASE_URL}", "responses")`,
    );
    runAppConsoleCommand(consoleRef, 'app.harness.setDefault("fake")');
    const harnessStorage = readHarnessStorage();
    writeArtifact("scenario-chatkit-thread-persistence-02-harness.txt", harnessStorage);
    if (harnessStorage.includes('"defaultHarnessName":"fake"')) {
      pass("Configured assistant harness via AppConsole");
    } else {
      fail("Failed to configure assistant harness via AppConsole");
    }
  }

  if (chatRef) {
    run(`agent-browser click ${chatRef}`);
    run("agent-browser wait 1200");
    pass("Opened ChatKit panel");
  }

  if (!waitForComposer()) {
    fail("ChatKit composer did not appear");
  } else {
    pass("ChatKit composer is visible");
  }

  const setDraftResult = setComposerValue(DRAFT_TEXT);
  if (setDraftResult.includes("typed")) {
    pass("Entered draft text in ChatKit composer");
  } else {
    fail(`Failed to set draft text in ChatKit composer (${setDraftResult})`);
  }
  const beforeSwitchValue = readComposerValue();
  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-chatkit-thread-persistence-03-before-switch.png")}`);

  if (explorerRef) {
    run(`agent-browser click ${explorerRef}`);
    run("agent-browser wait 1000");
    pass("Switched to Explorer tab");
  }
  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-chatkit-thread-persistence-04-explorer.png")}`);

  if (chatRef) {
    run(`agent-browser click ${chatRef}`);
    run("agent-browser wait 1200");
    pass("Returned to ChatKit tab");
  }

  const afterReturnValue = readComposerValue();
  const afterReturnSnapshot = run("agent-browser snapshot").stdout;
  writeArtifact(
    "scenario-chatkit-thread-persistence-07-composer-values.json",
    JSON.stringify(
      {
        expectedDraft: DRAFT_TEXT,
        beforeSwitchValue,
        afterReturnValue,
      },
      null,
      2,
    ),
  );
  writeArtifact(
    "scenario-chatkit-thread-persistence-06-after-return-snapshot.txt",
    afterReturnSnapshot,
  );
  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-chatkit-thread-persistence-05-after-return.png")}`);

  if (afterReturnValue.includes(DRAFT_TEXT)) {
    pass("Draft text is preserved after switching Explorer -> ChatKit");
  } else {
    fail(
      `Draft text was not preserved. Expected "${DRAFT_TEXT}", got "${afterReturnValue}"`,
    );
  }
} catch (error) {
  fail(`Scenario execution error: ${String(error)}`);
} finally {
  if (startedRecording) {
    run("agent-browser record stop");
  }
  if (CUJ_ID_TOKEN) {
    run(`agent-browser eval "localStorage.removeItem('oidc-auth'); 'ok'"`);
  }
  if (!AGENT_BROWSER_KEEP_OPEN) {
    run("agent-browser close");
  }
}

console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
