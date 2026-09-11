/** CUJ: docs-dev/cujs/authentication-settings-persistence.md.
 * Reproduce production startup precedence even when CI serves Vite development.
 * No authorization request or real credential is needed for this settings test.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, type Page, chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const dir = here.endsWith('/.generated') ? dirname(here) : here
const output = join(dir, 'test-output')
const session =
  process.env.AGENT_BROWSER_SESSION || `auth-settings-${Date.now()}`
const movie = join(output, 'scenario-authentication-settings.webm')
let connection: Browser | undefined
let page: Page | undefined
let saved: Record<string, string | null> | undefined
let passed = 0,
  failed = 0
mkdirSync(output, { recursive: true })

/** Share the orchestrator's browser, profile, recording, and cleanup conventions. */
function browser(...args: string[]): string {
  const flags = ['--session', session]
  if (process.env.AGENT_BROWSER_PROFILE)
    flags.push('--profile', process.env.AGENT_BROWSER_PROFILE)
  if (process.env.AGENT_BROWSER_HEADED === 'true') flags.push('--headed')
  return execFileSync('agent-browser', [...flags, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  }).trim()
}
/** Count checks independently of the workflow's exit status. */
function check(message: string, valid: boolean) {
  if (!valid) throw new Error(message)
  passed++
  console.log(`[PASS] ${message}`)
}
/** Reopen the same settings panel after a complete page reload. */
async function showSettings() {
  // Startup awaits deployment config before mounting React. Wait for the
  // toolbar before deciding whether the persisted panel is already open.
  await page!
    .getByRole('button', {
      name: 'Toggle Authentication Settings panel',
      exact: true,
    })
    .waitFor({ state: 'visible' })
  const heading = page!.getByRole('heading', {
    name: 'Authentication Settings',
    exact: true,
  })
  if (!(await heading.isVisible()))
    await page!
      .getByRole('button', {
        name: 'Toggle Authentication Settings panel',
        exact: true,
      })
      .click()
  await page!
    .getByLabel('Runme OAuth scopes', { exact: true })
    .waitFor({ state: 'visible' })
}

try {
  browser('open', process.env.CUJ_FRONTEND_URL || 'http://localhost:5173')
  browser('record', 'start', movie)
  const endpoint = JSON.parse(browser('get', 'cdp-url', '--json')).data.cdpUrl
  connection = await chromium.connectOverCDP(endpoint)
  const url = browser('get', 'url')
  page = connection
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === url)
  if (!page) throw new Error('Recorded page not found')
  page.setDefaultTimeout(15000)
  await page.waitForFunction(
    'Boolean(window.oidc?.getScope)'
  )
  saved = await page.evaluate(() =>
    Object.fromEntries(
      [
        'oidcConfig',
        'googleClientConfig',
        'runme/google-drive/runtime',
        'runme/app-config/prefer-local',
        'runme/app-login-configuration',
      ].map((key) => [key, localStorage.getItem(key)])
    )
  )
  // App mounts replace window.app with debug state. Seed the documented
  // preference directly instead of relying on that transient global API.
  await page.evaluate(() =>
    localStorage.setItem('runme/app-config/prefer-local', 'false')
  )
  await page.reload()
  await showSettings()
  const scopes = page.getByLabel('Runme OAuth scopes', { exact: true })
  const baseline = await scopes.inputValue()
  const custom = `${baseline} email regression_scope`
  await scopes.fill(custom)
  await page
    .getByRole('button', { name: 'Save authentication settings', exact: true })
    .click()
  check(
    'Saving authentication settings preserves local startup configuration',
    await page.evaluate(() =>
      localStorage.getItem('runme/app-config/prefer-local') === 'true'
    )
  )
  for (let reload = 1; reload <= 2; reload++) {
    await page.reload()
    await showSettings()
    check(
      `Saved email scope survives page reload ${reload}`,
      (await scopes.inputValue()) === custom
    )
    check(
      `OIDC runtime retains the same scopes after reload ${reload}`,
      (await page.evaluate('window.oidc.getScope()')) === custom
    )
  }
  await scopes.scrollIntoViewIfNeeded()
  browser(
    'screenshot',
    join(output, 'scenario-authentication-settings-reloaded.png')
  )
  await page.evaluate(() =>
    localStorage.setItem('runme/app-config/prefer-local', 'false')
  )
  await page.reload()
  await showSettings()
  check(
    'Explicitly restoring deployment defaults still works',
    (await scopes.inputValue()) === baseline
  )
} catch (error) {
  failed++
  console.log(`[FAIL] ${String(error)}`)
} finally {
  // These keys can contain credentials. Keep the snapshot in memory only and
  // restore it so this scenario cannot affect subsequent notebook scenarios.
  if (page && saved)
    await page
      .evaluate((values) => {
        for (const [key, value] of Object.entries(values)) {
          if (value === null) localStorage.removeItem(key)
          else localStorage.setItem(key, value)
        }
      }, saved)
      .catch(() => {})
  try {
    browser('record', 'stop')
  } catch (error) {
    failed++
    console.log(`[FAIL] Recording: ${String(error)}`)
  }
  await connection?.close()
  if (process.env.AGENT_BROWSER_KEEP_OPEN !== 'true') {
    try {
      browser('close')
    } catch {
      /* Keep the assertion result. */
    }
  }
}
console.log(`Movie: ${movie}`)
console.log(
  `Assertions: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`
)
process.exitCode = failed ? 1 : 0
