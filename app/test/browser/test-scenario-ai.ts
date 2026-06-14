import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_URL = process.env.CUJ_FRONTEND_URL ?? 'http://localhost:5173'
const CUJ_ID_TOKEN = process.env.CUJ_ID_TOKEN?.trim() ?? ''
const CUJ_ACCESS_TOKEN = process.env.CUJ_ACCESS_TOKEN?.trim() ?? CUJ_ID_TOKEN
const tokenExpiresAtEnv = Number(process.env.CUJ_TOKEN_EXPIRES_AT ?? '')
const CUJ_TOKEN_EXPIRES_AT =
  Number.isFinite(tokenExpiresAtEnv) && tokenExpiresAtEnv > Date.now()
    ? tokenExpiresAtEnv
    : Date.now() + 5 * 60 * 1000
const FAKE_CHATKIT_BASE_URL =
  process.env.CUJ_FAKE_CHATKIT_BASE_URL ?? 'http://127.0.0.1:19989'
const FAKE_CHATKIT_HEALTH_URL =
  process.env.CUJ_FAKE_CHATKIT_HEALTH_URL ?? `${FAKE_CHATKIT_BASE_URL}/healthz`
const FAKE_CHATKIT_RESET_URL =
  process.env.CUJ_FAKE_CHATKIT_RESET_URL ?? `${FAKE_CHATKIT_BASE_URL}/reset`
const FAKE_CHATKIT_REQUESTS_URL =
  process.env.CUJ_FAKE_CHATKIT_REQUESTS_URL ??
  `${FAKE_CHATKIT_BASE_URL}/requests`
const EXPECTED_RESPONSE_TEXT = 'Fake assistant response from CUJ server.'

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith('/.generated') ||
  CURRENT_FILE_DIR.endsWith('\\.generated')
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR
const OUTPUT_DIR = join(SCRIPT_DIR, 'test-output')
const MOVIE_PATH = join(OUTPUT_DIR, 'scenario-ai-walkthrough.webm')
const AGENT_BROWSER_SESSION = process.env.AGENT_BROWSER_SESSION?.trim() ?? ''
const AGENT_BROWSER_PROFILE = process.env.AGENT_BROWSER_PROFILE?.trim() ?? ''
const AGENT_BROWSER_HEADED =
  (process.env.AGENT_BROWSER_HEADED ?? 'false').trim().toLowerCase() === 'true'
const AGENT_BROWSER_KEEP_OPEN =
  (process.env.AGENT_BROWSER_KEEP_OPEN ?? 'false').trim().toLowerCase() ===
  'true'

type HarnessStorage = {
  harnesses?: Array<{
    name?: string
    baseUrl?: string
    adapter?: string
  }>
  defaultHarnessName?: string | null
}

let passCount = 0
let failCount = 0
let totalCount = 0

function run(command: string): {
  status: number
  stdout: string
  stderr: string
} {
  const effectiveCommand = withAgentBrowserOptions(command)
  const timeoutMs = Number(process.env.CUJ_SCENARIO_CMD_TIMEOUT_MS ?? '10000')
  const result = spawnSync(effectiveCommand, {
    shell: true,
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  const errorCode =
    typeof result.error === 'object' &&
    result.error !== null &&
    'code' in result.error
      ? String((result.error as { code?: string }).code ?? '')
      : ''
  const timedOut = errorCode === 'ETIMEDOUT'
  const timeoutHint = timedOut
    ? `\n[scenario-timeout] command timed out after ${timeoutMs}ms: ${effectiveCommand}\n`
    : ''
  if (timedOut && effectiveCommand.trim().startsWith('agent-browser ')) {
    throw new Error(timeoutHint.trim())
  }
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${timeoutHint}`,
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function withAgentBrowserOptions(command: string): string {
  const trimmed = command.trimStart()
  if (!trimmed.startsWith('agent-browser ')) {
    return command
  }
  const leadingWhitespace = command.slice(0, command.length - trimmed.length)
  const subcommand = trimmed.slice('agent-browser '.length)
  const args: string[] = []
  if (AGENT_BROWSER_SESSION) {
    args.push('--session', shellQuote(AGENT_BROWSER_SESSION))
  }
  if (AGENT_BROWSER_PROFILE) {
    args.push('--profile', shellQuote(AGENT_BROWSER_PROFILE))
  }
  if (AGENT_BROWSER_HEADED) {
    args.push('--headed')
  }
  const prefix = ['agent-browser', ...args].join(' ')
  return `${leadingWhitespace}${prefix} ${subcommand}`
}

function runOrThrow(command: string): string {
  const result = run(command)
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr}`)
  }
  return result.stdout
}

function pass(message: string): void {
  totalCount += 1
  passCount += 1
  console.log(`[PASS] ${message}`)
}

function fail(message: string): void {
  totalCount += 1
  failCount += 1
  console.log(`[FAIL] ${message}`)
}

function writeArtifact(name: string, content: string): void {
  writeFileSync(join(OUTPUT_DIR, name), content, 'utf-8')
}

function firstRef(snapshot: string, pattern: RegExp): string | null {
  const line = snapshot.split('\n').find((entry) => pattern.test(entry))
  if (!line) {
    return null
  }
  const legacyRef = line.match(/@[a-zA-Z0-9]+/)
  if (legacyRef) {
    return legacyRef[0]
  }
  const currentRef = line.match(/\[ref=([^\]]+)\]/)
  return currentRef ? currentRef[1] : null
}

function normalizeAgentBrowserString(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'string') {
      return parsed
    }
  } catch {
    // Keep the raw output when it is not JSON encoded.
  }
  return trimmed
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function readAppConsoleOutput(): string {
  return normalizeAgentBrowserString(
    run(
      `agent-browser eval "${escapeDoubleQuotes(`(() => {
        const completed = Array.from(
          document.querySelectorAll('[data-testid="app-console-cell"]'),
        ).filter((cell) => cell.getAttribute('data-status') !== 'draft');
        const last = completed[completed.length - 1];
        return last ? (last.textContent || '') : '';
      })()`)}"`
    ).stdout
  )
}

function runAppConsoleCommand(consoleRef: string, command: string): string {
  void consoleRef
  run(
    `agent-browser fill 'textarea[aria-label="App Console input"]' "${escapeDoubleQuotes(command)}"`
  )
  run(
    `agent-browser eval "${escapeDoubleQuotes(`(() => {
      const runButton = document.querySelector(
        '[data-testid="app-console-cell"][data-current="true"] [data-testid="app-console-cell-run"]',
      );
      if (!(runButton instanceof HTMLButtonElement)) {
        return 'missing-run-button';
      }
      runButton.click();
      return 'ok';
    })()`)}"`
  )
  run('agent-browser wait 900')
  return readAppConsoleOutput()
}

function openAppConsoleDocument(): boolean {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const output = run(
      `agent-browser eval "${escapeDoubleQuotes(`(() => {
        const button = document.querySelector('button[aria-label="Open App Console"]');
        if (!(button instanceof HTMLButtonElement)) return 'missing';
        button.click();
        return document.querySelector('textarea[aria-label="App Console input"]')
          ? 'visible'
          : 'clicked';
      })()`)}"`
    ).stdout
    if (output.includes('visible')) {
      return true
    }
    run('agent-browser wait 350')
  }
  return false
}

function parseJsonMaybeString(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed === 'string') {
    return JSON.parse(parsed)
  }
  return parsed
}

function readHarnessStorage(): HarnessStorage {
  const script = "localStorage.getItem('runme/harness') || '{}'"
  const result = run(`agent-browser eval "${escapeDoubleQuotes(script)}"`)
  try {
    return parseJsonMaybeString(result.stdout.trim()) as HarnessStorage
  } catch {
    return {}
  }
}

function resetFakeChatkitRequests(): boolean {
  const result = run(`curl -sf -X POST ${FAKE_CHATKIT_RESET_URL}`)
  return result.status === 0
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
      chat.addEventListener(
        'chatkit.error',
        (event) => push('chatkit.error', event?.detail ? String(event.detail.error || '') : null),
      );
      window.__cujChatkitProbeInstalled = true;
    }
    return 'ok';
  })()`
  run(`agent-browser eval "${escapeDoubleQuotes(script)}"`)
}

function readChatkitEventsRaw(): string {
  const script = `(() => JSON.stringify(window.__cujChatkitEvents || []))()`
  return run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout.trim()
}

function waitForChatkitEvent(name: string, timeoutMs = 25000): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const raw = readChatkitEventsRaw()
    try {
      const parsed = parseJsonMaybeString(raw)
      if (
        Array.isArray(parsed) &&
        parsed.some(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            (entry as { name?: string }).name === name
        )
      ) {
        return true
      }
    } catch {
      // retry
    }
    run('agent-browser wait 400')
  }
  return false
}

function readFakeChatkitRequests(): string {
  return run(`curl -sf ${FAKE_CHATKIT_REQUESTS_URL}`).stdout.trim()
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
  })()`
  return normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout
  )
}

function waitForComposer(timeoutMs = 15000): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = readComposerValue()
    if (current !== '__missing_composer__') {
      return true
    }
    run('agent-browser wait 400')
  }
  return false
}

type SidePanelName = 'explorer' | 'chatkit'

function readSidePanelPressedState(): {
  explorerPressed: string | null
  chatkitPressed: string | null
} {
  const script = `(() => JSON.stringify({
    explorerPressed: document.querySelector('button[aria-label="Toggle Explorer panel"]')?.getAttribute('aria-pressed') ?? null,
    chatkitPressed: document.querySelector('button[aria-label="Toggle ChatKit panel"]')?.getAttribute('aria-pressed') ?? null,
  }))()`
  const raw = normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(script)}"`).stdout
  )
  try {
    const parsed = JSON.parse(raw) as {
      explorerPressed?: string | null
      chatkitPressed?: string | null
    }
    return {
      explorerPressed: parsed.explorerPressed ?? null,
      chatkitPressed: parsed.chatkitPressed ?? null,
    }
  } catch {
    return {
      explorerPressed: null,
      chatkitPressed: null,
    }
  }
}

function waitForActiveSidePanel(
  panel: SidePanelName,
  timeoutMs = 5000
): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readSidePanelPressedState()
    if (
      panel === 'explorer' &&
      state.explorerPressed === 'true' &&
      state.chatkitPressed === 'false'
    ) {
      return true
    }
    if (
      panel === 'chatkit' &&
      state.chatkitPressed === 'true' &&
      state.explorerPressed === 'false'
    ) {
      return true
    }
    run('agent-browser wait 300')
  }
  return false
}

function ensureChatKitPanelOpen(timeoutMs = 5000): boolean {
  if (readSidePanelPressedState().chatkitPressed === 'true') {
    return true
  }
  const clickScript = `(() => {
    const button = document.querySelector('button[aria-label="Toggle ChatKit panel"]');
    if (!(button instanceof HTMLButtonElement)) {
      return 'missing-chatkit-toggle';
    }
    button.click();
    return 'clicked';
  })()`
  const clickResult = normalizeAgentBrowserString(
    run(`agent-browser eval "${escapeDoubleQuotes(clickScript)}"`).stdout
  )
  if (clickResult === 'missing-chatkit-toggle') {
    return false
  }
  return waitForActiveSidePanel('chatkit', timeoutMs)
}

function switchToSidePanelOrThrow({
  name,
  buttonPattern,
  activePanel,
}: {
  name: string
  buttonPattern: RegExp
  activePanel: SidePanelName
}): void {
  const deadline = Date.now() + 10000
  let lastError = 'unknown error'
  while (Date.now() < deadline) {
    if (waitForActiveSidePanel(activePanel, 200)) {
      return
    }
    const snapshot = run('agent-browser snapshot').stdout
    const ref = firstRef(snapshot, buttonPattern)
    if (!ref) {
      lastError = `missing ${name} button ref`
      run('agent-browser wait 300')
      continue
    }
    const clickResult = run(`agent-browser click ${ref}`)
    if (clickResult.status !== 0) {
      lastError = `click failed (${clickResult.status}): ${clickResult.stderr || clickResult.stdout || 'no output'}`
      run('agent-browser wait 300')
      continue
    }
    if (waitForActiveSidePanel(activePanel, 4000)) {
      return
    }
    lastError = `side panel did not become active after click (${name})`
  }
  throw new Error(`Failed to switch to ${name}: ${lastError}`)
}

function tryTypeChatMessage(message: string): string {
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
        } catch {
          // Ignore cross-origin frames.
        }
      }
      visit(document);
      return roots;
    };

    let activeRoot = null;
    let composer = null;
    for (const root of collectRoots()) {
      const candidate = Array.from(
        root.querySelectorAll(
          'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]',
        ),
      ).find((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        if (element.getAttribute('aria-label') === 'App Console input') {
          return false;
        }
        if (element.closest('[data-testid="app-console-cell"]')) {
          return false;
        }
        return true;
      }) ?? null;
      if (candidate) {
        activeRoot = root;
        composer = candidate;
        break;
      }
    }

    if (!composer || !activeRoot) {
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
      activeRoot.querySelector('button[aria-label*="Send"]') ||
      activeRoot.querySelector('button[type="submit"]');
    if (sendButton instanceof HTMLElement) {
      sendButton.click();
    }
    return 'typed';
  })()`
  const result = run(`agent-browser eval "${escapeDoubleQuotes(script)}"`)
  return `${result.stdout}\n${result.stderr}`.trim()
}

function typeChatMessageWithRetry(message: string, timeoutMs = 15000): string {
  const deadline = Date.now() + timeoutMs
  let lastOutput = ''
  while (Date.now() < deadline) {
    const output = tryTypeChatMessage(message)
    lastOutput = output
    if (output.includes('typed')) {
      return output
    }
    run('agent-browser wait 400')
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
  })()`
  const fallback = run(
    `agent-browser eval "${escapeDoubleQuotes(fallbackScript)}"`
  )
  const fallbackOutput = `${fallback.stdout}\n${fallback.stderr}`.trim()
  return `${lastOutput}\n${fallbackOutput}`.trim()
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
  })()`
  const result = run(`agent-browser eval "${escapeDoubleQuotes(script)}"`)
  return `${result.stdout}`.trim()
}

function waitForVisibleResponse(
  expectedText: string,
  timeoutMs = 20000
): { found: boolean; panelText: string; snapshot: string } {
  const deadline = Date.now() + timeoutMs
  let lastPanelText = ''
  let lastSnapshot = ''
  while (Date.now() < deadline) {
    const snapshot = run('agent-browser snapshot').stdout
    lastSnapshot = snapshot
    if (snapshot.includes(expectedText)) {
      return { found: true, panelText: lastPanelText, snapshot }
    }
    const panelText = readChatPanelText()
    lastPanelText = panelText
    if (panelText.includes(expectedText)) {
      return { found: true, panelText, snapshot: lastSnapshot }
    }
    run('agent-browser wait 500')
  }
  return { found: false, panelText: lastPanelText, snapshot: lastSnapshot }
}

mkdirSync(OUTPUT_DIR, { recursive: true })
rmSync(MOVIE_PATH, { force: true })
for (const file of [
  'scenario-ai-01-snapshot.txt',
  'scenario-ai-01b-app-console-open.txt',
  'scenario-ai-02-console.txt',
  'scenario-ai-03-send.txt',
  'scenario-ai-04-panel-text.txt',
  'scenario-ai-05-snapshot-after-send.txt',
  'scenario-ai-06-after-send.png',
  'scenario-ai-07-chatkit-events.json',
  'scenario-ai-08-chatkit-requests.json',
]) {
  rmSync(join(OUTPUT_DIR, file), { force: true })
}

if (run('command -v agent-browser').status !== 0) {
  console.error('ERROR: agent-browser is required on PATH')
  process.exit(2)
}

if (run(`curl -sf ${FRONTEND_URL}`).status !== 0) {
  console.error(`ERROR: frontend is not running at ${FRONTEND_URL}`)
  process.exit(1)
}

if (run(`curl -sf ${FAKE_CHATKIT_HEALTH_URL}`).status === 0) {
  pass(`AI service is healthy at ${FAKE_CHATKIT_HEALTH_URL}`)
} else {
  fail(`AI service is not reachable at ${FAKE_CHATKIT_HEALTH_URL}`)
}

if (resetFakeChatkitRequests()) {
  pass('Reset AI service request state')
} else {
  fail('Failed to reset AI service request state')
}

let startedRecording = false

try {
  runOrThrow(`agent-browser open ${FRONTEND_URL}`)
  runOrThrow(`agent-browser record restart ${MOVIE_PATH}`)
  startedRecording = true
  run('agent-browser wait 2200')

  if (CUJ_ID_TOKEN) {
    const idTokenLiteral = `'${CUJ_ID_TOKEN.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    const accessTokenLiteral = `'${CUJ_ACCESS_TOKEN.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
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
      })()"`
    )
    if (authSeed.status === 0 && authSeed.stdout.includes('ok')) {
      pass('Injected OIDC auth token')
      run('agent-browser reload')
      run('agent-browser wait 2200')
    } else {
      fail('Failed to inject OIDC auth token')
    }
  }

  const snapshot = run('agent-browser snapshot').stdout
  writeArtifact('scenario-ai-01-snapshot.txt', snapshot)

  const chatRef = firstRef(snapshot, /AI Chat|ChatKit panel/i)
  if (!chatRef) {
    fail('Could not find AI Chat button in side panel')
  }

  if (openAppConsoleDocument()) {
    run('agent-browser wait 600')
    pass('Opened App Console document tab')
  } else {
    fail('Could not open App Console document tab')
  }

  const consoleSnapshot = run('agent-browser snapshot').stdout
  writeArtifact('scenario-ai-01b-app-console-open.txt', consoleSnapshot)

  const consoleRef = firstRef(consoleSnapshot, /app console input|console-input/i)
  if (!consoleRef) {
    fail('Could not find App Console input')
  } else {
    pass('Found App Console input')
    runAppConsoleCommand(
      consoleRef,
      `app.harness.update("fake", "${FAKE_CHATKIT_BASE_URL}", "responses-direct")`
    )
    runAppConsoleCommand(consoleRef, 'app.harness.setDefault("fake")')
    const consoleOutput = runAppConsoleCommand(consoleRef, 'app.harness.get()')
    const harnessStorage = readHarnessStorage()
    writeArtifact(
      'scenario-ai-02-console.txt',
      `${consoleOutput}\n---\n${JSON.stringify(harnessStorage, null, 2)}`
    )
    const activeHarness = (harnessStorage.harnesses ?? []).find(
      (entry) => entry?.name === 'fake'
    )
    const isDefault = harnessStorage.defaultHarnessName === 'fake'
    const validHarness =
      activeHarness?.baseUrl === FAKE_CHATKIT_BASE_URL &&
      activeHarness?.adapter === 'responses-direct'
    if (isDefault && validHarness) {
      pass('Configured assistant harness via AppConsole')
    } else {
      fail('Failed to configure assistant harness via AppConsole')
    }
  }

  if (chatRef) {
    if (ensureChatKitPanelOpen()) {
      run('agent-browser wait 1000')
      installChatkitEventProbe()
      pass('Opened ChatKit panel')
    } else {
      fail('Failed to open ChatKit panel')
    }
  }

  const message = 'hello from ai cuj'
  const chatComposerReady = waitForComposer()
  const sendOutput = chatComposerReady
    ? typeChatMessageWithRetry(message)
    : 'chatkit-not-ready'
  writeArtifact('scenario-ai-03-send.txt', sendOutput)
  if (sendOutput.includes('typed')) {
    pass('Typed and submitted a message in the ChatKit panel')
  } else {
    fail(
      `Failed to type message in ChatKit panel (${sendOutput || 'no output'})`
    )
  }

  const responseResult = waitForVisibleResponse(EXPECTED_RESPONSE_TEXT)
  const sawResponseEndEvent = waitForChatkitEvent('chatkit.response.end', 30000)
  const chatkitEventsRaw = readChatkitEventsRaw()
  const chatkitRequestsRaw = readFakeChatkitRequests()
  writeArtifact('scenario-ai-04-panel-text.txt', responseResult.panelText)
  writeArtifact(
    'scenario-ai-05-snapshot-after-send.txt',
    responseResult.snapshot
  )
  run(
    `agent-browser screenshot ${join(OUTPUT_DIR, 'scenario-ai-06-after-send.png')}`
  )
  writeArtifact('scenario-ai-07-chatkit-events.json', chatkitEventsRaw || '[]')
  writeArtifact(
    'scenario-ai-08-chatkit-requests.json',
    chatkitRequestsRaw || '[]'
  )

  const sawChatkitError = (() => {
    try {
      const parsed = parseJsonMaybeString(chatkitEventsRaw)
      if (!Array.isArray(parsed)) {
        return false
      }
      return parsed.some(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          (entry as { name?: string }).name === 'chatkit.error'
      )
    } catch {
      return false
    }
  })()
  const postedChatkitRequest =
    chatkitRequestsRaw.includes('"path":"/v1/responses"') ||
    chatkitRequestsRaw.includes('"path":"/responses/direct/chatkit"')

  if (responseResult.found) {
    pass('User-visible assistant response appeared in ChatKit panel')
    run('agent-browser wait 1200')
  } else if (sawResponseEndEvent && postedChatkitRequest && !sawChatkitError) {
    pass(
      'Assistant response completed (DOM text probe did not expose rendered text in this runtime)'
    )
  } else {
    fail('Assistant response text did not appear in ChatKit panel')
  }
} catch (error) {
  fail(`Scenario execution error: ${String(error)}`)
} finally {
  if (startedRecording) {
    run('agent-browser record stop')
  }
  if (CUJ_ID_TOKEN) {
    run(`agent-browser eval "localStorage.removeItem('oidc-auth'); 'ok'"`)
  }
  if (!AGENT_BROWSER_KEEP_OPEN) {
    run('agent-browser close')
  }
}

console.log(`Movie: ${MOVIE_PATH}`)
console.log(
  `Assertions: ${totalCount}, Passed: ${passCount}, Failed: ${failCount}`
)
process.exit(failCount > 0 ? 1 : 0)
