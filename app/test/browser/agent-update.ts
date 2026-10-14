import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

type WebMcpTool = {
  name: string
  execute(args: Record<string, unknown>): Promise<string>
}
declare global {
  interface Window {
    __agentTools: Map<string, WebMcpTool>
  }
}

/** Exercise saved instruction updates in an actual browser JS cell, using only the Go fixture. */
async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    timeout: 20000,
  })
  const output = 'test/browser/test-output/agent-update'
  await mkdir(output, { recursive: true })
  try {
    const context = await browser.newContext()
    // Capture the real public WebMCP registrations in an isolated test profile.
    await context.addInitScript(() => {
      const tools = new Map<string, WebMcpTool>()
      window.__agentTools = tools
      Object.defineProperty(document, 'modelContext', {
        configurable: true,
        value: {
          registerTool(tool: WebMcpTool) {
            tools.set(tool.name, tool)
          },
        },
      })
    })
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return ['127.0.0.1', 'localhost'].includes(url.hostname)
        ? route.continue()
        : route.abort()
    })
    const page = await context.newPage()
    await page.goto('http://127.0.0.1:5173/?session=agent-update-cuj')
    await page.waitForFunction(
      () => window.__agentTools?.has('ExecuteCode'),
      undefined,
      { timeout: 60000 }
    )
    /** Use the same execution entry point exposed to notebook automation clients. */
    async function execute(code: string) {
      let result = await page.evaluate(
        async (code) =>
          JSON.parse(
            await window.__agentTools
              .get('ExecuteCode')!
              .execute({ code, timeoutMs: 1000 })
          ),
        code
      )
      const deadline = Date.now() + 30000
      while (['running', 'queued'].includes(result.status)) {
        assert(Date.now() < deadline, 'Code execution timed out')
        result = await page.evaluate(
          async (id) =>
            JSON.parse(
              await window.__agentTools
                .get('GetExecuteCodeOperation')!
                .execute({ operationId: id, waitMs: 1000 })
            ),
          result.operationId
        )
      }
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      return result.output.events.map((e: { text?: string }) => e.text).join('')
    }
    const source = `agents.configure({baseUrl:'http://127.0.0.1:8989/v1'});
const updated = await agents.updateAgent('agent_demo', {
  instructions: 'Updated instructions.', model: 'must-not-be-sent'
});
if(updated.id !== 'agent_demo' || updated.instructions !== 'Updated instructions.' || updated.model !== 'fixture-model') throw new Error('Saved update mismatch');
console.log('PASS: saved instructions updated; model preserved.');`
    const seeded = JSON.parse(
      await execute(`
      const doc = await notebooks.createLocal('agent-update.runme');
      const added = await notebooks.appendCell({target:{uri:doc.handle.uri},kind:'code',languageId:'javascript',value:${JSON.stringify(source)},metadata:{'runme.dev/runnerName':'appkernel-js'}});
      await notebooks.show(doc.handle.uri);
      console.log(JSON.stringify({uri:doc.handle.uri, refId:added.cell.refId}));
    `)
    )
    await execute(
      `await notebooks.execute({target:{uri:${JSON.stringify(seeded.uri)}},refIds:[${JSON.stringify(seeded.refId)}]});`
    )
    const cell = JSON.parse(
      await execute(
        `const doc = await notebooks.get({uri:${JSON.stringify(seeded.uri)}}); console.log(JSON.stringify(doc.notebook.cells[0]));`
      )
    )
    assert.equal(cell.metadata['runme.dev/exitCode'], '0', JSON.stringify(cell))
    await page
      .getByText('PASS: saved instructions updated; model preserved.', {
        exact: false,
      })
      .last()
      .waitFor({ timeout: 10000 })
    await page.screenshot({ path: `${output}/browser-cell.png` })
    await writeFile(
      `${output}/result.json`,
      JSON.stringify({ uri: seeded.uri, cell }, null, 2)
    )
    console.log(
      'PASS: browser JS notebook cell updated the fixture agent without changing its model'
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
