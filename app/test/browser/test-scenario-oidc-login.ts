/** Real-browser CUJ for all Runme OAuth flow/interaction combinations.
 * Uses the shared Go OIDC fixture, a fresh browser profile, and synthetic identities.
 * No real provider credentials, notebook data, or raw tokens enter artifacts.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const directory = here.endsWith('/.generated') ? dirname(here) : here
const root = resolve(directory, '../../..')
const output = join(directory, 'test-output')
const frontend = process.env.CUJ_FRONTEND_URL || 'http://localhost:5173'
const issuer = 'http://127.0.0.1:19984'
mkdirSync(output, { recursive: true })
const server = spawn('go', ['run', 'testing/cuj-oidc-server.go'], {
  cwd: root,
  env: {
    ...process.env,
    CUJ_OIDC_PORT: '19984',
    CUJ_OIDC_ISSUER: issuer,
    CUJ_OIDC_CLIENT_ID: 'cuj-web-client',
    CUJ_OIDC_TOKEN_FILE: '',
    CUJ_OIDC_EMAIL: 'cuj-user@example.com',
  },
  stdio: 'ignore',
  detached: true,
})
let browser: Browser | undefined
let passed = 0
let failed = 0
function check(message: string, valid: boolean) {
  if (!valid) throw new Error(message)
  passed++
  console.log(`[PASS] ${message}`)
}
/** Reuse the browser installed by agent-browser in CI even if its revision differs. */
function chromiumPath(): string | undefined {
  if (process.env.CUJ_CHROMIUM_PATH) return process.env.CUJ_CHROMIUM_PATH
  if (existsSync(chromium.executablePath())) return chromium.executablePath()
  const cache = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const entry of readdirSync(cache)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse()) {
    for (const path of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cache, entry, path)
      if (existsSync(candidate)) return candidate
    }
  }
}
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(issuer + '/healthz')
        .then((r) => r.ok)
        .catch(() => false)
    )
      break
    if (attempt > 120) throw new Error('Go OIDC fixture did not start')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath(),
    args: ['--no-sandbox'],
  })
  for (const flow of ['pkce', 'implicit']) {
    for (const mode of ['popup', 'new_tab', 'redirect']) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 1000 },
        recordVideo: { dir: output, size: { width: 1280, height: 1000 } },
      })
      const page = await context.newPage()
      page.setDefaultTimeout(20000)
      const video = page.video()
      try {
        await page.goto(frontend)
        await page
          .getByRole('button', {
            name: 'Toggle Authentication Settings panel',
            exact: true,
          })
          .click()
        await page
          .getByLabel('Runme OIDC discovery URL', { exact: true })
          .fill(issuer + '/.well-known/openid-configuration')
        await page
          .getByLabel('Runme OAuth client ID', { exact: true })
          .fill('cuj-web-client')
        await page
          .getByLabel('Runme OAuth client secret', { exact: true })
          .fill('')
        await page
          .getByLabel('Runme OAuth scopes', { exact: true })
          .fill('openid email')
        await page
          .getByLabel('Runme OAuth flow', { exact: true })
          .selectOption(flow)
        await page
          .getByLabel('Runme OAuth interaction', { exact: true })
          .selectOption(mode)
        await page
          .getByRole('button', {
            name: 'Save authentication settings',
            exact: true,
          })
          .click()
        await page
          .getByLabel('Runme OAuth flow', { exact: true })
          .scrollIntoViewIfNeeded()
        await page.screenshot({
          path: join(output, `scenario-oidc-settings-${flow}-${mode}.png`),
        })
        await page.reload()
        await page
          .getByRole('heading', {
            name: 'Authentication Settings',
            exact: true,
          })
          .waitFor()
        check(
          `${flow}/${mode}: saved options survive reload`,
          (await page
            .getByLabel('Runme OAuth flow', { exact: true })
            .inputValue()) === flow &&
            (await page
              .getByLabel('Runme OAuth interaction', { exact: true })
              .inputValue()) === mode
        )
        // Right click must be available while signed out, without authorizing.
        await page
          .getByRole('button', { name: 'Login', exact: true })
          .click({ button: 'right' })
        await page.getByText('Signed out', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Login', exact: true }).click()
        await page
          .getByRole('button', { name: 'Logout', exact: true })
          .waitFor()
        await page
          .getByRole('button', { name: 'Logout', exact: true })
          .click({ button: 'right' })
        await page
          .locator('#oidc-status-tab')
          .getByText('cuj-user@example.com', { exact: true })
          .waitFor()
        check(
          `${flow}/${mode}: real callback authenticates the original tab`,
          (
            await page.getByTestId('oidc-detail-Status').textContent()
          )?.includes('Active') === true
        )
        check(
          `${flow}/${mode}: records actual session interaction`,
          (
            await page
              .getByTestId('oidc-detail-Session browser interaction')
              .textContent()
          )?.includes(
            {
              popup: 'Popup',
              new_tab: 'New tab',
              redirect: 'Same-page redirect',
            }[mode]!
          ) === true
        )
        await page.screenshot({
          path: join(output, `scenario-oidc-login-${flow}-${mode}.png`),
        })
        await page.getByRole('button', { name: 'Logout', exact: true }).click()
        await page.getByText('Signed out', { exact: true }).waitFor()
        check(
          `${flow}/${mode}: details update after logout`,
          (await page
            .locator('#oidc-status-tab')
            .getByText('cuj-user@example.com', { exact: true })
            .count()) === 0
        )
      } finally {
        await context.close()
        if (video) {
          const movie = join(output, `scenario-oidc-login-${flow}-${mode}.webm`)
          await video.saveAs(movie)
          await video.delete()
          console.log(`Movie: ${movie}`)
        }
      }
    }
  }
} catch (error) {
  failed++
  console.log(`[FAIL] ${String(error)}`)
} finally {
  await browser?.close()
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {
      /* already stopped */
    }
  }
}
console.log(
  `Assertions: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`
)
process.exitCode = failed ? 1 : 0
