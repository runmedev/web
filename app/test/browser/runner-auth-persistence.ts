import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { type Page, chromium } from 'playwright-core'

type Tool = {
  name: string
  execute(input: Record<string, unknown>): Promise<string>
}
declare global {
  interface Window {
    __runnerTools: Map<string, Tool>
  }
}

/** Test durable signer restoration and cross-tab revocation with a synthetic key only.
 * Run against Vite on port 5173; no runner or external service is contacted.
 */
async function main() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    timeout: 20000,
  })
  const output = 'test/browser/test-output/runner-auth-persistence'
  await mkdir(output, { recursive: true })
  try {
    const context = await browser.newContext()
    await context.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1'
        ? route.continue()
        : route.abort()
    )
    await context.addInitScript(() => {
      window.__runnerTools = new Map()
      Object.defineProperty(document, 'modelContext', {
        configurable: true,
        value: {
          registerTool(tool: Tool) {
            window.__runnerTools.set(tool.name, tool)
          },
        },
      })
    })
    /** Wait for real WebMCP registration after each navigation. */
    async function ready(page: Page) {
      await page.waitForFunction(
        () => window.__runnerTools?.has('configureRunnerAuth'),
        undefined,
        { timeout: 60000 }
      )
    }
    /** Exercise the dedicated tool so secret input never enters notebook history. */
    async function invoke(
      page: Page,
      name: string,
      input: Record<string, unknown>
    ) {
      return JSON.parse(
        await page.evaluate(
          async ({ name, input }) =>
            window.__runnerTools.get(name)!.execute(input),
          { name, input }
        )
      )
    }
    /** Call the production signer module in the isolated Vite browser to verify the JWT. */
    async function token(page: Page) {
      return page.evaluate(async () => {
        const path = '/src/auth/runnerAuth.ts'
        const api = await import(path)
        return api.getRunnerTokenForEndpoint(
          'ws://localhost:9988/ws'
        ) as Promise<string>
      })
    }
    const first = await context.newPage()
    await first.goto('http://127.0.0.1:5173/?session=runner-auth-first')
    await ready(first)
    const status = await invoke(first, 'configureRunnerAuth', {
      runnerName: 'local-test',
      runnerBaseUrl: 'http://localhost:9988',
      issuer: 'urn:runme:test',
      audience: 'urn:runme:runner',
      subject: 'runme',
      keyId: 'synthetic',
      privateKeyPkcs8Pem: await exportPKCS8(privateKey),
    })
    assert.equal(status.configured, true)
    assert(!JSON.stringify(status).includes('PRIVATE KEY'))
    const runner = await first.evaluate(() =>
      JSON.parse(localStorage.getItem('runme/runners')!).find(
        (r: { name: string }) => r.name === 'local-test'
      )
    )
    assert.equal(runner.endpoint, 'ws://localhost:9988/ws')
    await first.reload()
    await ready(first)
    await jwtVerify(await token(first), publicKey, {
      issuer: 'urn:runme:test',
      audience: 'urn:runme:runner',
    })
    const second = await context.newPage()
    await second.goto('http://127.0.0.1:5173/?session=runner-auth-second')
    await ready(second)
    await jwtVerify(await token(second), publicKey)
    await invoke(first, 'clearRunnerAuth', { runnerName: 'local-test' })
    assert.equal(
      (
        await invoke(second, 'getRunnerAuthStatus', {
          runnerName: 'local-test',
        })
      ).configured,
      false
    )
    await assert.rejects(token(second), /needs key provisioning/)
    await second.reload()
    await ready(second)
    await assert.rejects(token(second), /needs key provisioning/)
    const result = {
      httpRegistersWs: true,
      reloadSigning: true,
      secondTabSigning: true,
      clearedAcrossTabsAndReload: true,
    }
    await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2))
    console.log(
      'PASS: HTTP→WS, reload/new-tab signing, and durable cross-tab clear'
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
