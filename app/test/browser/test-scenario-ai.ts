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
const EXPECTED_RESPONSE_TEXT = "Fake assistant response from CUJ server.";

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-ai-walkthrough.webm");

type HarnessStorage = {
  harnesses?: Array<{
    name?: string;
    baseUrl?: string;
    adapter?: string;
  }>;
  defaultHarnessName?: string | null;
};

let passCount = 0;
let failCount = 0;
let totalCount = 0;

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

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppConsoleCommand(consoleRef: string, command: string): string {
  run(`agent-browser click ${consoleRef}`);
  run(`agent-browser type ${consoleRef} "${escapeDoubleQuotes(command)}"`);
  run("agent-browser press Enter");
  run("agent-browser wait 900");
  return run("agent-browser get text '#app-console-output'").stdout;
}

function parseJsonMaybeString(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed === "string") {
    return JSON.parse(parsed);
  }
  return parsed;
}

function readHarnessStorage(): HarnessStorage {
  const script = "localStorage.getItem('runme/harness') || '{}'";
  const result = run(`agent-browser eval "${escapeDoubleQuotes(script)}"`);
  try {
    return parseJsonMaybeString(result.stdout.trim()) as HarnessStorage;
  } catch {
    return {};
  }
}

function resetFakeChatkitRequests(): boolean {
  const result = run(`curl -sf -X POST ${FAKE_CHATKIT_RESET_URL}`);
  return result.status === 0;
}

function tryTypeChatMessage(message: string): string {
  const script = `(() => {
    const docs = [document];
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = frame.contentDocument;
        if (doc) {
          docs.push(doc);
        }
      } catch {
        // Ignore cross-origin frames.
      }
    }

    let activeDoc = null;
    let composer = null;
    for (const doc of docs) {
      const candidate = doc.querySelector('textarea') ||
        doc.querySelector('[contenteditable="true"][role="textbox"]') ||
        doc.querySelector('[contenteditable="true"]');
      if (candidate) {
        activeDoc = doc;
        composer = candidate;
        break;
      }
    }

    if (!composer || !activeDoc) {
      return 'missing-composer';
    }

    if (composer instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      );
      if (descriptor?.set) {
        descriptor.set.call(composer, ${JSON.stringify(message)});
      } else {
        composer.value = ${JSON.stringify(message)};
      }
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      composer.textContent = ${JSON.stringify(message)};
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }

    composer.focus();
    const eventInit = {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    };
    composer.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    composer.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    composer.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    const sendButton =
      activeDoc.querySelector('button[aria-label*="Send"]') ||
      activeDoc.querySelector('button[type="submit"]');
    if (sendButton instanceof HTMLElement) {
      sendButton.click();
    }
    return 'typed';
  })()`;
  const result = run(`agent-browser eval "${escapeDoubleQuotes(script)}"`);
  return `${result.stdout}\n${result.stderr}`.trim();
}

function typeChatMessageWithRetry(message: string, timeoutMs = 15000): string {
  const deadline = Date.now() + timeoutMs;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const output = tryTypeChatMessage(message);
    lastOutput = output;
    if (output.includes("typed")) {
      return output;
    }
    run("agent-browser wait 400");
  }
  const fallbackScript = `(async () => {
    const chat = document.querySelector('openai-chatkit');
    if (!chat || typeof chat.sendUserMessage !== 'function') {
      return 'missing-chatkit-element';
    }
    try {
      if (typeof chat.focusComposer === 'function') {
        await chat.focusComposer();
      }
      if (typeof chat.setComposerValue === 'function') {
        await chat.setComposerValue({ text: ${JSON.stringify(message)} });
      }
      // Fire and return so scenario typing does not block on model latency.
      const pending = chat.sendUserMessage({ text: ${JSON.stringify(message)} });
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {});
      }
      return 'typed-fallback';
    } catch (error) {
      return 'fallback-error:' + String(error);
    }
  })()`;
  const fallback = run(`agent-browser eval "${escapeDoubleQuotes(fallbackScript)}"`);
  const fallbackOutput = `${fallback.stdout}\n${fallback.stderr}`.trim();
  return `${lastOutput}\n${fallbackOutput}`.trim();
}

function readChatPanelText(): string {
  const script = `(() => {
    const docs = [document];
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = frame.contentDocument;
        if (doc) {
          docs.push(doc);
        }
      } catch {
        // Ignore cross-origin frames.
      }
    }
    return docs
      .map((doc) => doc.body?.innerText || '')
      .filter((text) => text.length > 0)
      .join('\\n');
  })()`;
  const result = run(`agent-browser eval "${escapeDoubleQuotes(script)}"`);
  return `${result.stdout}`.trim();
}

function waitForVisibleResponse(
  expectedText: string,
  timeoutMs = 20000,
): { found: boolean; panelText: string; snapshot: string } {
  const deadline = Date.now() + timeoutMs;
  let lastPanelText = "";
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    const snapshot = run("agent-browser snapshot").stdout;
    lastSnapshot = snapshot;
    if (snapshot.includes(expectedText)) {
      return { found: true, panelText: lastPanelText, snapshot };
    }
    const panelText = readChatPanelText();
    lastPanelText = panelText;
    if (panelText.includes(expectedText)) {
      return { found: true, panelText, snapshot: lastSnapshot };
    }
    run("agent-browser wait 500");
  }
  return { found: false, panelText: lastPanelText, snapshot: lastSnapshot };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
rmSync(MOVIE_PATH, { force: true });
for (const file of [
  "scenario-ai-01-snapshot.txt",
  "scenario-ai-02-console.txt",
  "scenario-ai-03-send.txt",
  "scenario-ai-04-panel-text.txt",
  "scenario-ai-05-snapshot-after-send.txt",
  "scenario-ai-06-after-send.png",
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

  const snapshot = run("agent-browser snapshot").stdout;
  writeArtifact("scenario-ai-01-snapshot.txt", snapshot);

  const chatRef = firstRef(snapshot, /AI Chat|ChatKit panel/i);
  if (!chatRef) {
    fail("Could not find AI Chat button in side panel");
  }

  const consoleRef = firstRef(snapshot, /console-input|terminal input/i);
  if (!consoleRef) {
    fail("Could not find AppConsole terminal input");
  } else {
    pass("Found AppConsole terminal input");
    runAppConsoleCommand(consoleRef, `app.harness.update("fake", "${FAKE_CHATKIT_BASE_URL}", "responses")`);
    runAppConsoleCommand(consoleRef, 'app.harness.setDefault("fake")');
    const consoleOutput = runAppConsoleCommand(consoleRef, "app.harness.get()");
    const harnessStorage = readHarnessStorage();
    writeArtifact(
      "scenario-ai-02-console.txt",
      `${consoleOutput}\n---\n${JSON.stringify(harnessStorage, null, 2)}`,
    );
    const activeHarness = (harnessStorage.harnesses ?? []).find((entry) => entry?.name === "fake");
    const isDefault = harnessStorage.defaultHarnessName === "fake";
    const validHarness = activeHarness?.baseUrl === FAKE_CHATKIT_BASE_URL &&
      activeHarness?.adapter === "responses";
    if (isDefault && validHarness) {
      pass("Configured assistant harness via AppConsole");
    } else {
      fail("Failed to configure assistant harness via AppConsole");
    }
  }

  if (chatRef) {
    run(`agent-browser click ${chatRef}`);
    run("agent-browser wait 1400");
    pass("Opened ChatKit panel");
  }

  const message = "hello from ai cuj";
  const sendOutput = typeChatMessageWithRetry(message);
  writeArtifact("scenario-ai-03-send.txt", sendOutput);
  if (sendOutput.includes("typed")) {
    pass("Typed and submitted a message in the ChatKit panel");
  } else {
    fail(`Failed to type message in ChatKit panel (${sendOutput || "no output"})`);
  }

  const responseResult = waitForVisibleResponse(EXPECTED_RESPONSE_TEXT);
  writeArtifact("scenario-ai-04-panel-text.txt", responseResult.panelText);
  writeArtifact("scenario-ai-05-snapshot-after-send.txt", responseResult.snapshot);
  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-ai-06-after-send.png")}`);
  if (responseResult.found) {
    pass("User-visible assistant response appeared in ChatKit panel");
    run("agent-browser wait 1200");
  } else {
    fail("Assistant response text did not appear in ChatKit panel");
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
  run("agent-browser close");
}

console.log(`Movie: ${MOVIE_PATH}`);
console.log(`Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
