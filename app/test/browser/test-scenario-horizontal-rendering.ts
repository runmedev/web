/** CUJ: docs-dev/cujs/horizontal-rendering.md.
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
const url = process.env.CUJ_FRONTEND_URL ?? 'http://localhost:5173'
const session =
  process.env.AGENT_BROWSER_SESSION?.trim() ||
  `horizontal-rendering-${Date.now()}`
const profile = process.env.AGENT_BROWSER_PROFILE?.trim()
const headed = process.env.AGENT_BROWSER_HEADED?.toLowerCase() === 'true'
const keepOpen = process.env.AGENT_BROWSER_KEEP_OPEN?.toLowerCase() === 'true'
const movie = join(output, 'scenario-horizontal-rendering.webm')
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
  const options = ['--session', session]
  if (profile) options.push('--profile', profile)
  if (headed) options.push('--headed')
  return execFileSync('agent-browser', [...options, ...args], {
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
  browser('record', 'start', movie)
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
    // Capture the blocks the geometry checks cover, not just the first screen.
    // Pressing Right must move each local scroll region; focusability alone
    // would miss keyboard handlers that accidentally swallow navigation.
    for (const [name, selector] of [
      ['code', '#markdown-rendered-markup_horizontal_rendering pre'],
      [
        'table',
        '#markdown-rendered-markup_horizontal_rendering [role="region"]:has(th:nth-child(12))',
      ],
    ]) {
      browser('scrollintoview', selector)
      browser('focus', selector)
      const before = JSON.parse(
        browser(
          'eval',
          `document.querySelector(${JSON.stringify(selector)}).scrollLeft`
        )
      )
      browser('press', 'ArrowRight')
      browser(
        'wait',
        '--fn',
        `document.querySelector(${JSON.stringify(selector)}).scrollLeft > ${Number(before)}`
      )
      check(`${width}: ${name} scrolls with the keyboard`, true)
      browser(
        'screenshot',
        join(output, `scenario-horizontal-rendering-${width}-${name}.png`)
      )
    }
    browser('scrollintoview', '[data-testid="cell-output-item"]')
    browser(
      'screenshot',
      join(output, `scenario-horizontal-rendering-${width}-output.png`)
    )
    browser('scrollintoview', '#markdown-rendered-markup_horizontal_sibling')
    browser(
      'screenshot',
      join(output, `scenario-horizontal-rendering-${width}-sibling.png`)
    )
    browser(
      'scrollintoview',
      '#markdown-rendered-markup_horizontal_rendering h1'
    )
  }
} catch (error) {
  check(String(error), false)
} finally {
  try {
    browser('record', 'stop')
  } catch (error) {
    check(`Could not finalize browser recording: ${error}`, false)
  }
  if (!keepOpen) {
    try {
      browser('close')
    } catch {
      /* Preserve test result during cleanup. */
    }
  }
}
console.log(`Movie: ${movie}`)
console.log(
  `Assertions: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`
)
process.exitCode = failed ? 1 : 0
