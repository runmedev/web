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

/** Exercise infinite history scrolling in an actual browser JS cell, using only the Go fixture. */
async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    timeout: 20000,
  })
  const output = 'test/browser/test-output/agent-history'
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
    await page.goto('http://127.0.0.1:5173/?session=agent-history-cuj')
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
    const requests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/v1/agents/')) requests.push(request.url())
    })
    const source = `agents.configure({baseUrl:'http://127.0.0.1:8989/v1'});
const widget = agents.monitor('sess_demo', {pageSize:5});`
    const seeded = JSON.parse(
      await execute(`
      const doc = await notebooks.createLocal('agent-history.runme');
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
    const timeline = page.getByTestId('agent-monitor-timeline')
    await timeline.waitFor()
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="agent-monitor"]')
        ?.textContent?.includes('Connection: live')
    )
    assert.equal(
      await page.getByRole('button', { name: 'Older', exact: true }).count(),
      0
    )
    // Capture a visible item before scrolling triggers a prepend. The same text
    // must stay at the same viewport offset after the asynchronous read commits.
    const before = await timeline.evaluate((el) => {
      el.scrollTop = 20
      const top = el.getBoundingClientRect().top
      const node = Array.from(
        el.querySelectorAll<HTMLElement>('[data-agent-item-key]')
      ).find((n) => n.getBoundingClientRect().bottom > top)!
      const anchor = {
        key: node.dataset.agentItemKey,
        offset: node.getBoundingClientRect().top - top,
      }
      el.dispatchEvent(new Event('scroll'))
      return anchor
    })
    await page.waitForFunction(() =>
      document.querySelector('[data-agent-item-key="msg_119"]')
    )
    const after = await timeline.evaluate((el, key) => {
      const node = Array.from(
        el.querySelectorAll<HTMLElement>('[data-agent-item-key]')
      ).find((n) => n.dataset.agentItemKey === key)!
      return node.getBoundingClientRect().top - el.getBoundingClientRect().top
    }, before.key)
    assert(
      Math.abs(after - before.offset) < 2,
      'Prepending changed reading position: ' +
        JSON.stringify({ before, after })
    )
    // Scroll repeatedly until the oldest turn is reached. This traverses both
    // per-turn item cursors and the fixture's paginated turn collection.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await timeline.locator('[data-agent-item-key="msg_1"]').count()) break
      const count = await timeline.locator('[data-agent-item-key]').count()
      await timeline.evaluate((el) => {
        el.scrollTop = 0
        el.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, bubbles: true })
        )
        el.dispatchEvent(new Event('scroll'))
      })
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-agent-item-key]').length > count,
        count,
        { timeout: 10000 }
      )
    }
    assert.equal(
      await timeline.locator('[data-agent-item-key="msg_1"]').count(),
      1
    )
    assert(requests.some((url) => url.includes('/turns/turn_first/items')))
    assert(
      !requests.some((url) =>
        new URL(url).pathname.endsWith('/sess_demo/items')
      ),
      'Monitor requested session-wide items'
    )
    assert.equal(
      requests.filter((url) => url.includes('/events?stream=true')).length,
      1,
      'History paging reconnected the stream'
    )
    const position = await timeline.evaluate((el) => el.scrollTop)
    await page.waitForTimeout(2200)
    assert.equal(
      await timeline.evaluate((el) => el.scrollTop),
      position,
      'Live output moved scrollback'
    )
    await page.getByRole('button', { name: /^Latest/ }).click()
    const bottomGap = await timeline.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight
    )
    assert(bottomGap < 2, 'Latest did not scroll to the bottom')
    await page.screenshot({ path: output + '/browser-cell.png' })
    await writeFile(
      output + '/result.json',
      JSON.stringify(
        { uri: seeded.uri, before, after, bottomGap, requests },
        null,
        2
      )
    )
    console.log(
      'PASS: infinite scroll crosses turn boundaries, preserves the reading anchor, and keeps one live stream'
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
