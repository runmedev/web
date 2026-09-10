/** CUJ: docs-dev/CUJs/horizontal-rendering.md.
 * Use stored output and synthetic Markdown: no runner or authenticated service
 * is needed. Layout must be checked in Chromium; jsdom has no layout engine.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = here.endsWith('/.generated') ? dirname(here) : here
const output = join(dir, 'test-output')
const url = process.env.FRONTEND_URL ?? 'http://127.0.0.1:5173'
const session = `horizontal-rendering-${Date.now()}`
const uri = 'local://file/horizontal-rendering-regression'
const fixture = JSON.parse(
  readFileSync(
    resolve(dir, '../fixtures/notebooks/horizontal-rendering.json'),
    'utf8'
  )
)
mkdirSync(output, { recursive: true })
let passed = 0
let failed = 0

/** Invoke the existing CUJ browser tool with argument boundaries preserved. */
function browser(...args: string[]): string {
  return execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim()
}

/** Measure visible elements only: inactive tabs deliberately remain mounted. */
function inspectLayout() {
  const column = document.querySelector<HTMLElement>(
    '[role="tabpanel"][data-state="active"] #notebook-column'
  )!
  const viewport = column.closest<HTMLElement>('.rt-ScrollAreaViewport')!
  const markdown = column.querySelector<HTMLElement>('.notebook-markdown')!
  const paragraph = markdown.querySelector<HTMLElement>('p')!
  const tables = [...markdown.querySelectorAll('table')]
  const pre = markdown.querySelector<HTMLElement>('pre')!
  const output = column.querySelector<HTMLElement>(
    '[data-testid="cell-output-item"] pre'
  )!
  const rect = paragraph.getBoundingClientRect()
  const pane = viewport.getBoundingClientRect()
  return {
    viewport: viewport.clientWidth,
    column: column.clientWidth,
    scroll: viewport.scrollWidth,
    proseFits: rect.left >= pane.left && rect.right <= pane.right + 1,
    proseWraps:
      rect.height > parseFloat(getComputedStyle(paragraph).lineHeight) * 1.5,
    smallTableFits:
      tables[0].scrollWidth <= tables[0].parentElement!.clientWidth + 1,
    wideTableScrolls:
      tables[1].parentElement!.scrollWidth >
        tables[1].parentElement!.clientWidth &&
      getComputedStyle(tables[1].parentElement!).overflowX === 'auto',
    codeScrolls:
      pre.scrollWidth > pre.clientWidth &&
      getComputedStyle(pre).overflowX === 'auto',
    scrollRegionsFocusable:
      pre.tabIndex === 0 && tables[1].parentElement!.tabIndex === 0,
    outputFits: output.scrollWidth <= output.clientWidth + 1,
    outputIntact: output.textContent!.includes(
      'unbroken_output_identifier_'.repeat(500)
    ),
    siblingFits:
      column.querySelectorAll('.notebook-markdown').length === 2 &&
      [...column.querySelectorAll<HTMLElement>('.notebook-markdown')].every(
        (cell) => {
          const bounds = cell.getBoundingClientRect()
          return bounds.left >= pane.left && bounds.right <= pane.right + 1
        }
      ),
  }
}

/** Fail on missing elements rather than treating empty measurements as success. */
function check(name: string, ok: boolean) {
  if (ok) passed++
  else failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
}

try {
  browser('open', url)
  browser('record', 'start', join(output, 'scenario-horizontal-rendering.webm'))
  // Recording may replace the context. Seed only after recording has started.
  browser('wait', '--fn', 'Boolean(window.app?.localNotebooks)')
  browser(
    'eval',
    `(async () => {
    const store = window.app?.localNotebooks;
    if (!store) throw new Error('Local notebook store is not ready');
    await store.files.put({
      id:${JSON.stringify(uri)}, uri:${JSON.stringify(uri)},
      name:'horizontal-rendering.json', remoteId:'',
      doc:${JSON.stringify(JSON.stringify(fixture))},
      parent:'local://folder/local', updatedAt:new Date().toISOString(),
      lastSynced:'', lastRemoteChecksum:''
    });
    sessionStorage.setItem('runme/openNotebooks',JSON.stringify([{uri:${JSON.stringify(uri)},name:'horizontal-rendering.json',type:'file',children:[],parents:['local://folder/local']} ]));
    sessionStorage.setItem('runme/currentDoc',${JSON.stringify(uri)});
  })()`
  )
  browser('reload')
  browser('wait', '#markdown-rendered-markup_horizontal_rendering')
  browser('wait', '[data-testid="cell-output-item"] pre')
  browser('wait', '--fn', 'document.fonts.status === "loaded"')
  // Exercise a normal and a narrow viewport; the sidebar may consume width too.
  for (const width of [1280, 900]) {
    browser('set', 'viewport', String(width), '900')
    browser('wait', '300')
    const raw = browser('eval', `(${inspectLayout.toString()})()`)
    let result = JSON.parse(raw)
    if (typeof result === 'string') result = JSON.parse(result)
    writeFileSync(
      join(output, `scenario-horizontal-rendering-${width}.json`),
      JSON.stringify(result, null, 2)
    )
    check(
      `${width}: notebook width is bounded`,
      result.column <= result.viewport + 1 &&
        result.scroll <= result.viewport + 1
    )
    for (const key of [
      'proseFits',
      'proseWraps',
      'smallTableFits',
      'wideTableScrolls',
      'codeScrolls',
      'scrollRegionsFocusable',
      'outputFits',
      'outputIntact',
      'siblingFits',
    ])
      check(`${width}: ${key}`, result[key] === true)
    browser(
      'screenshot',
      join(output, `scenario-horizontal-rendering-${width}.png`)
    )
  }
} catch (error) {
  check(String(error), false)
} finally {
  try {
    browser('record', 'stop')
  } catch {
    /* The first failure is reported above. */
  }
  try {
    browser('close')
  } catch {
    /* Preserve test result during cleanup. */
  }
}
console.log(
  `Assertions: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`
)
process.exitCode = failed ? 1 : 0
