import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_URL = process.env.CUJ_FRONTEND_URL ?? "http://localhost:5173";
const BACKEND_URL = process.env.CUJ_BACKEND_URL ?? "http://localhost:9977";
const SCENARIO_NOTEBOOK_NAME = "scenario-ai-codex.runme.md";
const SCENARIO_CELL_ID = "cell_ai_codex";
const CUJ_ID_TOKEN = process.env.CUJ_ID_TOKEN?.trim() ?? "";
const CUJ_ACCESS_TOKEN = process.env.CUJ_ACCESS_TOKEN?.trim() ?? CUJ_ID_TOKEN;
const tokenExpiresAtEnv = Number(process.env.CUJ_TOKEN_EXPIRES_AT ?? "");
const CUJ_TOKEN_EXPIRES_AT = Number.isFinite(tokenExpiresAtEnv) && tokenExpiresAtEnv > Date.now()
  ? tokenExpiresAtEnv
  : Date.now() + 5 * 60 * 1000;
const FAKE_CHATKIT_BASE_URL = process.env.CUJ_FAKE_CHATKIT_BASE_URL ?? "http://127.0.0.1:19989";
const FAKE_CHATKIT_HEALTH_URL = process.env.CUJ_FAKE_CHATKIT_HEALTH_URL ?? `${FAKE_CHATKIT_BASE_URL}/healthz`;
const FAKE_CHATKIT_RESET_URL = process.env.CUJ_FAKE_CHATKIT_RESET_URL ?? `${FAKE_CHATKIT_BASE_URL}/reset`;
const FAKE_CHATKIT_REQUESTS_URL = process.env.CUJ_FAKE_CHATKIT_REQUESTS_URL ?? `${FAKE_CHATKIT_BASE_URL}/requests`;
const FAKE_CODEX_REQUESTS_URL = process.env.CUJ_FAKE_CODEX_REQUESTS_URL ?? `${FAKE_CHATKIT_BASE_URL}/codex/requests`;
const USER_PROMPT_TEXT = `Add a cell to print("hello world")`;
const FIRST_AI_RESPONSE_TEXT = `Ok, I'll add a cell to print("hello world").`;
const FINAL_AI_RESPONSE_TEXT = "Cell has been added.";
const EXPECTED_NEW_CELL_TEXT = `print("hello world")`;
const EXPECTED_NEW_CELL_ID = "cell_ai_codex_added";

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const MOVIE_PATH = join(OUTPUT_DIR, "scenario-ai-codex-walkthrough.webm");

let passCount = 0;
let failCount = 0;
let totalCount = 0;

function run(command: string): { status: number; stdout: string; stderr: string } {
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? "15000");
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

function lastRef(snapshot: string, pattern: RegExp): string | null {
  const lines = snapshot.split("\n").filter((entry) => pattern.test(entry));
  const line = lines.at(-1);
  if (!line) {
    return null;
  }
  const legacyRefMatches = [...line.matchAll(/@[a-zA-Z0-9]+/g)];
  if (legacyRefMatches.length > 0) {
    return legacyRefMatches.at(-1)?.[0] ?? null;
  }
  const currentRefMatches = [...line.matchAll(/\[ref=([^\]]+)\]/g)];
  return currentRefMatches.at(-1)?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function hasCommandError(output: string): boolean {
  return /TypeError:|ReferenceError:|SyntaxError:|Command finished \(exit code [1-9]\d*\)/.test(
    output,
  );
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

function resetFakeServices(): boolean {
  const result = run(`curl -sf -X POST ${FAKE_CHATKIT_RESET_URL}`);
  return result.status === 0;
}

function tryTypeChatMessage(message: string): string {
  const script = `(() => {
    const docs = [document];
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = frame.contentDocument;
        if (doc) docs.push(doc);
      } catch {}
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
    if (!composer || !activeDoc) return 'missing-composer';
    if (composer instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(composer, ${JSON.stringify(message)});
      else composer.value = ${JSON.stringify(message)};
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      composer.textContent = ${JSON.stringify(message)};
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    composer.focus();
    const eventInit = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    composer.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    composer.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    const sendButton = activeDoc.querySelector('button[aria-label*="Send"]') || activeDoc.querySelector('button[type="submit"]');
    if (sendButton instanceof HTMLElement) sendButton.click();
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

function sendUserMessageViaChatkitApi(message: string): string {
  const script = `(async () => {
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
      const pending = chat.sendUserMessage({ text: ${JSON.stringify(message)} });
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {});
      }
      return 'sent-via-chatkit-api';
    } catch (error) {
      return 'chatkit-api-error:' + String(error);
    }
  })()`;
  const result = run(`agent-browser eval "${escapeDoubleQuotes(script)}"`);
  return `${result.stdout}\n${result.stderr}`.trim();
}

function installChatkitEventProbe(): void {
  const script = `(() => {
    const chat = document.querySelector('openai-chatkit');
    if (!chat) return 'missing-chatkit-element';
    if (!window.__cujChatkitProbeInstalled) {
      window.__cujChatkitEvents = [];
      window.__cujChatkitReady = false;
      const push = (name, detail) => {
        const events = Array.isArray(window.__cujChatkitEvents) ? window.__cujChatkitEvents : [];
        events.push({ name, detail: detail ?? null, ts: Date.now() });
        window.__cujChatkitEvents = events.slice(-200);
      };
      chat.addEventListener('chatkit.ready', () => {
        window.__cujChatkitReady = true;
        push('chatkit.ready', null);
      });
      chat.addEventListener('chatkit.response.start', () => push('chatkit.response.start', null));
      chat.addEventListener('chatkit.response.end', () => push('chatkit.response.end', null));
      chat.addEventListener('chatkit.error', (event) => push('chatkit.error', event?.detail ? String(event.detail.error || '') : null));
      chat.addEventListener('chatkit.log', (event) => push('chatkit.log', event?.detail ?? null));
      window.__cujChatkitProbeInstalled = true;
    }
    return window.__cujChatkitReady ? 'ready' : 'installed';
  })()`;
  run(`agent-browser eval "${escapeDoubleQuotes(script)}"`);
}

function waitForChatkitReady(timeoutMs = 30000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = run(
      `agent-browser eval "${escapeDoubleQuotes(`(() => (window.__cujChatkitReady ? 'ready' : 'not-ready'))()`)}"`,
    ).stdout.trim();
    if (ready === "ready" || ready === `"ready"`) {
      return true;
    }
    run("agent-browser wait 500");
  }
  return false;
}

function readChatkitEvents(): string {
  const script = `(() => JSON.stringify(window.__cujChatkitEvents || []))()`;
  return run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout.trim();
}

function installCujTranscriptOverlay(): void {
  const script = `(() => {
    const id = 'cuj-chat-transcript';
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement('div');
      root.id = id;
      root.setAttribute('data-testid', id);
      Object.assign(root.style, {
        position: 'fixed',
        left: '56px',
        top: '56px',
        zIndex: '99999',
        maxWidth: '360px',
        background: 'rgba(255,255,255,0.96)',
        border: '1px solid #cbd5e1',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        padding: '8px 10px',
        font: '12px/1.4 monospace',
        color: '#0f172a',
        whiteSpace: 'pre-wrap'
      });
      document.body.appendChild(root);
    }
    window.__cujTranscript = [];
    root.textContent = 'CUJ transcript\\n';
    return 'ok';
  })()`;
  run(`agent-browser eval "${escapeDoubleQuotes(script)}"`);
}

function appendCujTranscriptLine(role: string, text: string): void {
  const script = `(() => {
    const root = document.getElementById('cuj-chat-transcript');
    if (!root) return 'missing-overlay';
    const lines = Array.isArray(window.__cujTranscript) ? window.__cujTranscript : [];
    const line = ${JSON.stringify(`${role}: ${text}`)};
    if (!lines.includes(line)) lines.push(line);
    window.__cujTranscript = lines;
    root.textContent = ['CUJ transcript', ...lines].join('\\n');
    return root.textContent;
  })()`;
  run(`agent-browser eval "${escapeDoubleQuotes(script)}"`);
}

function readCujTranscriptOverlayText(): string {
  const script = `(() => document.getElementById('cuj-chat-transcript')?.textContent || '')()`;
  return normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout,
  );
}

function readVisibleEditorTexts(): string {
  const script = `(() => {
    const texts = new Set();
    for (const el of Array.from(document.querySelectorAll('textarea'))) {
      const value = (el.value || '').trim();
      if (value) texts.add(value);
    }
    try {
      const monaco = window.monaco;
      const models = monaco?.editor?.getModels?.() || [];
      for (const model of models) {
        const value = typeof model?.getValue === 'function' ? String(model.getValue()).trim() : '';
        if (value) texts.add(value);
      }
    } catch {}
    for (const el of Array.from(document.querySelectorAll('.view-lines, .monaco-editor'))) {
      const text = (el.textContent || '').trim();
      if (text) texts.add(text);
    }
    return JSON.stringify(Array.from(texts));
  })()`;
  return normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout,
  );
}

function readChatPanelText(): string {
  const script = `(() => {
    const docs = [document];
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = frame.contentDocument;
        if (doc) docs.push(doc);
      } catch {}
    }
    return docs.map((doc) => doc.body?.innerText || '').filter(Boolean).join('\\n');
  })()`;
  return run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout.trim();
}

function waitForVisibleSnapshotTexts(
  expectedTexts: string[],
  timeoutMs = 25000,
): { found: boolean; panelText: string; snapshot: string } {
  const deadline = Date.now() + timeoutMs;
  let lastPanelText = "";
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    const snapshot = run("agent-browser snapshot").stdout;
    lastSnapshot = snapshot;
    if (expectedTexts.every((text) => snapshot.includes(text))) {
      return { found: true, panelText: lastPanelText, snapshot };
    }
    const panelText = readChatPanelText();
    lastPanelText = panelText;
    if (expectedTexts.every((text) => panelText.includes(text))) {
      return { found: true, panelText, snapshot };
    }
    run("agent-browser wait 500");
  }
  return { found: false, panelText: lastPanelText, snapshot: lastSnapshot };
}

function waitForNotebookProbe(
  probeScript: string,
  predicate: (value: any) => boolean,
  timeoutMs = 30000,
): { ok: boolean; raw: string; parsed?: any } {
  const deadline = Date.now() + timeoutMs;
  let lastRaw = "";
  while (Date.now() < deadline) {
    lastRaw = run(`agent-browser eval "${escapeDoubleQuotes(probeScript)}"`).stdout.trim();
    try {
      const parsedOnce = JSON.parse(lastRaw) as unknown;
      const parsed = typeof parsedOnce === "string" ? JSON.parse(parsedOnce) : parsedOnce;
      if (predicate(parsed)) {
        return { ok: true, raw: lastRaw, parsed };
      }
    } catch {
      // retry
    }
    run("agent-browser wait 500");
  }
  return { ok: false, raw: lastRaw };
}

function waitForFakeChatkitRequest(
  path: string,
  timeoutMs = 20000,
  options?: { bodyIncludes?: string; skipBodyIncludes?: string },
): string {
  const deadline = Date.now() + timeoutMs;
  let lastRaw = "";
  while (Date.now() < deadline) {
    const result = run(`curl -sf ${FAKE_CHATKIT_REQUESTS_URL}`);
    lastRaw = result.stdout.trim();
    if (result.status === 0 && lastRaw) {
      try {
        const parsed = JSON.parse(lastRaw) as Array<{ path?: string; body?: string }>;
        const matched = parsed.some((entry) => {
          if (entry.path !== path) {
            return false;
          }
          const body = entry.body ?? "";
          if (options?.skipBodyIncludes && body.includes(options.skipBodyIncludes)) {
            return false;
          }
          if (options?.bodyIncludes && !body.includes(options.bodyIncludes)) {
            return false;
          }
          return true;
        });
        if (matched) {
          return lastRaw;
        }
      } catch {
        // retry
      }
    }
    run("agent-browser wait 400");
  }
  return lastRaw;
}

function hasNonBootstrapChatkitRequest(raw: string): boolean {
  if (!raw.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as Array<{ path?: string; body?: string }>;
    return parsed.some(
      (entry) =>
        entry.path === "/chatkit-codex" && !(entry.body ?? "").includes(`"type":"threads.list"`),
    );
  } catch {
    return false;
  }
}

function hasPromptInChatkitRequest(raw: string, expectedPrompt: string): boolean {
  if (!raw.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as Array<{ path?: string; body?: string }>;
    return parsed.some((entry) => {
      if (entry.path !== "/chatkit-codex" || !entry.body) {
        return false;
      }
      try {
        const body = JSON.parse(entry.body) as {
          params?: { input?: { content?: Array<{ text?: string }> } };
        };
        const content = body.params?.input?.content ?? [];
        return content.some((part) => part?.text === expectedPrompt);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function waitForCodexUpdateTraffic(timeoutMs = 30000): string {
  const deadline = Date.now() + timeoutMs;
  let lastRaw = "";
  while (Date.now() < deadline) {
    const result = run(`curl -sf ${FAKE_CODEX_REQUESTS_URL}`);
    lastRaw = result.stdout.trim();
    if (result.status === 0 && lastRaw) {
      try {
        const parsed = JSON.parse(lastRaw) as Array<{ body?: string; direction?: string; type?: string }>;
        const joined = parsed.map((entry) => entry.body ?? "").join("\n");
        const hasInboundUpdateResponse = parsed.some((entry) => {
          if (entry.direction !== "inbound") {
            return false;
          }
          const body = entry.body ?? "";
          return body.includes("\"bridge_update\"") || body.includes("\"call_update\"");
        });
        const hasUpdateResponse =
          joined.includes("\"bridge_update\"") &&
          joined.includes("\"updateCells\"") &&
          hasInboundUpdateResponse;
        if (hasUpdateResponse) {
          return lastRaw;
        }
      } catch {
        // retry
      }
    }
    run("agent-browser wait 400");
  }
  return lastRaw;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
rmSync(MOVIE_PATH, { force: true });
for (const file of [
  "scenario-ai-codex-01-initial.png",
  "scenario-ai-codex-02-console.txt",
  "scenario-ai-codex-02-harness-storage.json",
  "scenario-ai-codex-03-opened-notebook.txt",
  "scenario-ai-codex-04-send.txt",
  "scenario-ai-codex-05-chat-ack.txt",
  "scenario-ai-codex-06-notebook-probe.json",
  "scenario-ai-codex-07-chat-final.txt",
  "scenario-ai-codex-08-snapshot-final.txt",
  "scenario-ai-codex-09-codex-requests.json",
  "scenario-ai-codex-10-chatkit-requests.json",
  "scenario-ai-codex-11-after-run.png",
  "scenario-ai-codex-12-visible-editor-texts.json",
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

if (run(`curl -sf ${FAKE_CHATKIT_HEALTH_URL}`).status === 0) {
  pass(`AI service is healthy at ${FAKE_CHATKIT_HEALTH_URL}`);
} else {
  fail(`AI service is not reachable at ${FAKE_CHATKIT_HEALTH_URL}`);
}
if (resetFakeServices()) {
  pass("Reset fake AI/codex service state");
} else {
  fail("Failed to reset fake AI/codex service state");
}

let startedRecording = false;
try {
  runOrThrow(`agent-browser open ${FRONTEND_URL}`);
  runOrThrow(`agent-browser record restart ${MOVIE_PATH}`);
  startedRecording = true;
  run("agent-browser wait 2500");

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

  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-ai-codex-01-initial.png")}`);

  const seedResult = run(
    `agent-browser eval "(async () => {
      const ln = window.app?.localNotebooks;
      if (!ln) return 'missing-local-notebooks';
      const notebook = {
        metadata: {},
        cells: [
          {
            refId: '${SCENARIO_CELL_ID}',
            kind: 2,
            languageId: 'bash',
            value: 'echo \\"before codex\\"',
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
    pass("Created local notebook fixture for codex scenario");
  } else {
    fail("Failed to create local notebook fixture for codex scenario");
  }

  let snapshot = run("agent-browser snapshot -i").stdout;
  const consoleRef = firstRef(snapshot, /Terminal input/i);
  if (!consoleRef) {
    fail("Did not find AppConsole terminal input");
  } else {
    pass("Found AppConsole terminal input");

    const runnerName = "local";
    const runnerEndpoint = "ws://localhost:9977/ws";
    runAppConsoleCommand(consoleRef, `app.runners.update("${runnerName}", "${runnerEndpoint}")`);
    runAppConsoleCommand(consoleRef, `app.runners.setDefault("${runnerName}")`);
    runAppConsoleCommand(consoleRef, `app.harness.update("fake-codex", "${FAKE_CHATKIT_BASE_URL}", "codex")`);
    runAppConsoleCommand(consoleRef, `app.harness.setDefault("fake-codex")`);
    const consoleOutput = runAppConsoleCommand(consoleRef, "app.harness.get()");
    const harnessStorage = normalizeAgentBrowserString(
      run(
        `agent-browser eval "${escapeDoubleQuotes(`(() => localStorage.getItem('runme/harness') || '')()`)}"`,
      ).stdout,
    );
    writeArtifact("scenario-ai-codex-02-console.txt", consoleOutput);
    writeArtifact(
      "scenario-ai-codex-02-harness-storage.json",
      harnessStorage || "<empty>",
    );
    const harnessConfigured = (() => {
      if (!harnessStorage.trim()) {
        return false;
      }
      try {
        const parsed = JSON.parse(harnessStorage) as {
          defaultName?: string;
          defaultHarnessName?: string;
          harnesses?: Array<{ name?: string; baseUrl?: string; adapter?: string }>;
        };
        const matching = (parsed.harnesses ?? []).find((h) => h.name === "fake-codex");
        return (
          (parsed.defaultHarnessName === "fake-codex" || parsed.defaultName === "fake-codex") &&
          matching?.baseUrl === FAKE_CHATKIT_BASE_URL &&
          matching?.adapter === "codex"
        );
      } catch {
        return false;
      }
    })();
    if (
      harnessConfigured &&
      !hasCommandError(consoleOutput)
    ) {
      pass("Configured codex harness via AppConsole");
    } else {
      fail("Failed to configure codex harness via AppConsole");
    }
  }

  snapshot = run("agent-browser snapshot -i").stdout;
  const collapseBottomPaneRef = firstRef(snapshot, /Collapse bottom pane/i);
  if (collapseBottomPaneRef) {
    run(`agent-browser click ${collapseBottomPaneRef}`);
    run("agent-browser wait 700");
  }

  snapshot = run("agent-browser snapshot -i").stdout;
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
    run("agent-browser wait 1500");
    pass("Opened codex scenario notebook");
  } else {
    fail("Could not find codex scenario notebook in explorer");
  }
  writeArtifact("scenario-ai-codex-03-opened-notebook.txt", run("agent-browser snapshot -i").stdout);

  const chatSnapshot = run("agent-browser snapshot").stdout;
  const chatRef = firstRef(chatSnapshot, /AI Chat|ChatKit panel/i);
  if (chatRef) {
    run(`agent-browser click ${chatRef}`);
    run("agent-browser wait 1500");
    installCujTranscriptOverlay();
    installChatkitEventProbe();
    pass("Opened ChatKit panel");
  } else {
    fail("Could not find AI Chat button");
  }

  if (waitForChatkitReady(20000)) {
    pass("ChatKit panel reported ready");
  } else {
    fail(`ChatKit panel did not report ready (events=${readChatkitEvents()})`);
  }

  run("agent-browser wait 600");
  let sendOutput = typeChatMessageWithRetry(USER_PROMPT_TEXT);
  let chatkitRequestsAfterSend = waitForFakeChatkitRequest("/chatkit-codex", 3000, {
    skipBodyIncludes: `"type":"threads.list"`,
  });
  if (!hasNonBootstrapChatkitRequest(chatkitRequestsAfterSend)) {
    const fallbackSend = sendUserMessageViaChatkitApi(USER_PROMPT_TEXT);
    sendOutput = `${sendOutput}\n${fallbackSend}`.trim();
    chatkitRequestsAfterSend = waitForFakeChatkitRequest("/chatkit-codex", 30000, {
      skipBodyIncludes: `"type":"threads.list"`,
    });
  }
  writeArtifact("scenario-ai-codex-04-send.txt", sendOutput);
  if ((sendOutput.includes("typed") || sendOutput.includes("sent-via-chatkit-api")) && hasNonBootstrapChatkitRequest(chatkitRequestsAfterSend)) {
    appendCujTranscriptLine("User", USER_PROMPT_TEXT);
    pass(`User enters into chatkit "${USER_PROMPT_TEXT}"`);
  } else {
    fail(`Failed to send codex request in ChatKit panel (${sendOutput || "no output"})`);
  }

  const firstChatResult = waitForVisibleSnapshotTexts(
    [FIRST_AI_RESPONSE_TEXT],
    30000,
  );
  writeArtifact("scenario-ai-codex-05-chat-ack.txt", firstChatResult.snapshot);
  if (firstChatResult.found) {
    appendCujTranscriptLine("Assistant", FIRST_AI_RESPONSE_TEXT);
    pass(`AI responds with "${FIRST_AI_RESPONSE_TEXT}"`);
  } else {
    fail("Did not see the initial AI response rendered in the ChatKit panel");
  }

  if (!chatkitRequestsAfterSend.includes("/chatkit-codex")) {
    fail("Did not observe /chatkit-codex request to fake AI service");
  } else if (hasPromptInChatkitRequest(chatkitRequestsAfterSend, USER_PROMPT_TEXT)) {
    pass("Observed /chatkit-codex request to fake AI service with the user prompt");
  } else {
    fail("Observed /chatkit-codex request but the expected user prompt was missing");
  }

  const codexUpdateTraffic = waitForCodexUpdateTraffic();
  if (codexUpdateTraffic.includes("bridge_update") && codexUpdateTraffic.includes("updateCells")) {
    pass(`Fake code server sends websocket response to add a cell with ${EXPECTED_NEW_CELL_TEXT}`);
  } else {
    fail("Did not observe complete codex websocket updateCells traffic");
  }

  const notebookProbeScript = `(async () => {
    const ln = window.app?.localNotebooks;
    if (!ln) return JSON.stringify({ status: 'missing-local-notebooks' });
    const rec = await ln.files.get('local://file/${SCENARIO_NOTEBOOK_NAME}');
    if (!rec) return JSON.stringify({ status: 'missing-notebook-record' });
    const doc = JSON.parse(rec.doc || '{}');
    const cells = Array.isArray(doc.cells) ? doc.cells : [];
    const addedCell = cells.find((cell) => cell?.refId === '${EXPECTED_NEW_CELL_ID}');
    return JSON.stringify({
      status: 'ok',
      cellsCount: cells.length,
      addedRefId: addedCell?.refId || '',
      addedValue: addedCell?.value || '',
    });
  })()`;

  const notebookProbe = waitForNotebookProbe(
    notebookProbeScript,
    (parsed) =>
      parsed?.status === "ok" &&
      Number(parsed?.cellsCount ?? 0) >= 2 &&
      parsed?.addedRefId === EXPECTED_NEW_CELL_ID &&
      typeof parsed?.addedValue === "string" &&
      parsed.addedValue.includes(EXPECTED_NEW_CELL_TEXT),
    30000,
  );
  writeArtifact("scenario-ai-codex-06-notebook-probe.json", notebookProbe.raw);
  if (notebookProbe.ok) {
    pass(`Codex tool calls added a new cell with ${EXPECTED_NEW_CELL_TEXT}`);
  } else {
    fail("Notebook was not updated with the expected codex-added cell");
  }

  const finalAiResult = waitForVisibleSnapshotTexts([FINAL_AI_RESPONSE_TEXT], 30000);
  if (finalAiResult.found) {
    appendCujTranscriptLine("Assistant", FINAL_AI_RESPONSE_TEXT);
  }
  const transcriptOverlayText = readCujTranscriptOverlayText();
  writeArtifact("scenario-ai-codex-07-chat-final.txt", transcriptOverlayText);
  writeArtifact("scenario-ai-codex-08-snapshot-final.txt", finalAiResult.snapshot);
  run(`agent-browser screenshot ${join(OUTPUT_DIR, "scenario-ai-codex-11-after-run.png")}`);
  if (finalAiResult.found) {
    pass(`AI sends chatkit message "${FINAL_AI_RESPONSE_TEXT}"`);
  } else {
    fail("Did not see the final AI response rendered in the ChatKit panel");
  }
  if (
    transcriptOverlayText.includes(`User: ${USER_PROMPT_TEXT}`) &&
    transcriptOverlayText.includes(`Assistant: ${FIRST_AI_RESPONSE_TEXT}`) &&
    transcriptOverlayText.includes(`Assistant: ${FINAL_AI_RESPONSE_TEXT}`)
  ) {
    pass("Visible CUJ transcript shows user message and both AI messages");
  } else {
    fail("Visible CUJ transcript overlay did not contain the expected user/assistant messages");
  }
  const visibleEditorTextsRaw = readVisibleEditorTexts();
  writeArtifact("scenario-ai-codex-12-visible-editor-texts.json", visibleEditorTextsRaw);
  const hasSecondCellInSnapshot =
    finalAiResult.snapshot.includes('textbox "Editor content" [ref=') &&
    finalAiResult.snapshot.includes("[nth=1]");
  if (visibleEditorTextsRaw.includes(EXPECTED_NEW_CELL_TEXT) || hasSecondCellInSnapshot) {
    pass("Updated notebook UI shows the codex-added cell");
  } else {
    fail("Updated notebook UI did not show the codex-added cell");
  }
  if (finalAiResult.snapshot.includes("Codex bridge error:")) {
    fail("Codex bridge error banner was visible in the ChatKit panel");
  } else {
    pass("No codex bridge error banner was shown");
  }

  const codexRequestsRaw = waitForCodexUpdateTraffic(5000);
  const chatkitRequestsRaw = waitForFakeChatkitRequest("/chatkit-codex", 5000);
  writeArtifact("scenario-ai-codex-09-codex-requests.json", codexRequestsRaw);
  writeArtifact("scenario-ai-codex-10-chatkit-requests.json", chatkitRequestsRaw);
  try {
    const codexMessages = JSON.parse(codexRequestsRaw) as Array<{ body?: string; direction?: string }>;
    const allBodies = codexMessages.map((m) => m.body ?? "").join("\n");
    const hasList = /bridge_list|call_list/.test(allBodies);
    const hasUpdate = /bridge_update|call_update/.test(allBodies);
    const hasAddedCellText = codexMessages.some((message) => {
      if (message.direction !== "outbound" || !message.body) {
        return false;
      }
      try {
        const parsed = JSON.parse(message.body) as {
          tool_call_input?: { updateCells?: { cells?: Array<{ value?: string }> } };
        };
        const cells = parsed.tool_call_input?.updateCells?.cells ?? [];
        return cells.some((cell) => cell?.value === EXPECTED_NEW_CELL_TEXT);
      } catch {
        return false;
      }
    });
    if (hasList && hasUpdate && hasAddedCellText) {
      pass("Fake codex websocket server observed list/update tool call traffic");
    } else {
      fail("Missing expected list/update traffic in fake codex websocket logs");
    }
  } catch (error) {
    fail(`Failed to parse fake codex websocket logs: ${String(error)}`);
  }

  run("agent-browser wait 1800");
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
