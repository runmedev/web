/** CUJ: docs-dev/cujs/editor-range-comments.md.
 * Exercise real Monaco keyboard/menu events and durable operation-log anchors.
 * No runner, credentials, or fake service is needed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, type Page, chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const dir = here.endsWith('/.generated') ? dirname(here) : here
const output = join(dir, 'test-output')
const session =
  process.env.AGENT_BROWSER_SESSION?.trim() || `editor-comments-${Date.now()}`
const profile = process.env.AGENT_BROWSER_PROFILE?.trim()
const headed = process.env.AGENT_BROWSER_HEADED?.toLowerCase() === 'true'
const keepOpen = process.env.AGENT_BROWSER_KEEP_OPEN?.toLowerCase() === 'true'
const movie = join(output, 'scenario-editor-range-comments.webm')
const sources = [
  '# 😀 first\nprint(123)',
  '# Markdown source\n\n😀 **first**\nsecond',
]
mkdirSync(output, { recursive: true })
let passed = 0
let failed = 0
let inputBrowser: Browser | undefined
let inputPage: Page

/** Preserve argument boundaries and the orchestrator's browser configuration. */
function browser(...args: string[]): string {
  const options = ['--session', session]
  if (profile) options.push('--profile', profile)
  if (headed) options.push('--headed')
  try {
    return execFileSync('agent-browser', [...options, ...args], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim()
  } catch (error) {
    throw new Error(
      `agent-browser ${args[0]} ${args[0] === 'eval' ? '(script)' : args.slice(1).join(' ')}: ${error}`
    )
  }
}

/** Evaluate setup and storage assertions; interactions below use real input. */
function evaluate(code: string): any {
  let result = JSON.parse(browser('eval', `(async () => { ${code} })()`))
  if (typeof result === 'string') result = JSON.parse(result)
  return result
}

/** Count every assertion so the suite can reject a partial walkthrough. */
function check(name: string, ok: boolean) {
  if (ok) passed++
  else throw new Error(name)
  console.log(`[PASS] ${name}`)
}

/** Save the actual draft through the visible comments panel. */
function submit(content: string) {
  browser(
    'fill',
    '[aria-label="Notebook comments"] textarea:not([placeholder])',
    content
  )
  browser('find', 'role', 'button', 'click', '--name', 'Comment', '--exact')
  browser(
    'wait',
    '--fn',
    `!document.querySelector('[aria-label="Notebook comments"] textarea:not([placeholder])')`
  )
}

try {
  browser('open', process.env.CUJ_FRONTEND_URL ?? 'http://localhost:5173')
  browser('record', 'start', movie)
  browser('wait', '--fn', 'Boolean(window.app?.localNotebooks)')
  const fixture = evaluate(`
    const db = window.app.localNotebooks;
    const { LOCAL_FOLDER_URI } = await import('/src/storage/local.ts');
    const { parseOperationLog, serializeOperationLog, createRunmeOperation, causalHeads } = await import('/src/lib/operationLog/index.ts');
    if (!await db.folders.get(LOCAL_FOLDER_URI)) await db.folders.put({id:LOCAL_FOLDER_URI,name:'Local',remoteId:'',children:[],lastSynced:''});
    const file = await db.create(LOCAL_FOLDER_URI, 'editor-range-comments.runme');
    const notebook = await db.load(file.uri);
    await (await db.createOperationLogSaveStore(file.uri)).save(file.uri, notebook);
    const log = parseOperationLog(await db.loadContent(file.uri));
    for (const [index,value] of ${JSON.stringify(sources)}.entries()) {
      log.operations.push(createRunmeOperation({actorId:'editor-range-fixture',actorSequence:index+1,
        knownOperations:log.operations,dependencies:causalHeads(log.operations),kind:'cell.create',
        payload:{cell_id:'editor-range-'+index,position:[[index+1,'editor-range-fixture',index+1]],
          cell:{kind:index === 0 ? 'code' : 'markup',language_id:index === 0 ? 'python' : 'markdown',value,metadata:{}}}}));
    }
    await db.saveContent(file.uri, serializeOperationLog(log.header,log.operations), 'application/vnd.runme.notebook+jsonl');
    sessionStorage.setItem('runme/openNotebooks', JSON.stringify([{uri:file.uri,name:file.name,type:'file',children:[]}]));
    sessionStorage.setItem('runme/currentDoc', file.uri);
    return {uri:file.uri};
  `)
  browser('reload')
  const codeInput = '#code-action-editor-range-0 textarea'
  const markdownInput = '#markdown-action-editor-range-1 textarea'
  browser('wait', codeInput)
  // The pinned agent-browser native CLI treats chord strings as a single key.
  // Attach Playwright only for real keyboard input; retain the suite's existing
  // browser session, recorder, setup, snapshots, and artifacts.
  const endpoint = JSON.parse(browser('get', 'cdp-url', '--json')).data.cdpUrl
  inputBrowser = await chromium.connectOverCDP(endpoint)
  const activeUrl = browser('get', 'url')
  const activePage = inputBrowser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url() === activeUrl)
  if (!activePage) throw new Error('Cannot find the recorded browser page')
  inputPage = activePage
  // From offset one through the end, crossing a surrogate pair and a newline.
  browser('focus', codeInput)
  for (const key of [
    'ControlOrMeta+a',
    'ArrowLeft',
    'ArrowRight',
    'Shift+ArrowDown',
    'Shift+End',
    'Shift+F10',
  ])
    await inputPage.keyboard.press(key)
  browser('wait', '[aria-label="Comment on selection"]')
  check('Monaco context menu offers Comment on selection', true)
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-code-menu.png')
  )
  browser('click', '[aria-label="Comment on selection"]')
  browser('wait', '[aria-label="Notebook comments"] blockquote')
  check(
    'Code draft contains only the selected multiline source',
    evaluate(
      `return document.querySelector('[aria-label="Notebook comments"] blockquote').textContent === ${JSON.stringify(sources[0].slice(1))};`
    )
  )
  check(
    'Code draft visibly preserves source line breaks',
    evaluate(`
    const quote = document.querySelector('[aria-label="Notebook comments"] blockquote');
    const style = getComputedStyle(quote);
    return style.whiteSpace === 'pre-wrap' && quote.getBoundingClientRect().height >= 2 * parseFloat(style.lineHeight);
  `)
  )
  submit('Code selection comment')

  browser('dblclick', '#markdown-rendered-editor-range-1')
  browser('wait', markdownInput)
  browser('focus', markdownInput)
  for (const key of [
    'ControlOrMeta+a',
    'ArrowLeft',
    'ArrowDown',
    'ArrowDown',
    'Shift+ArrowDown',
    'Shift+End',
    'ControlOrMeta+Alt+m',
  ])
    await inputPage.keyboard.press(key)
  browser(
    'wait',
    '[aria-label="Notebook comments"] textarea:not([placeholder])'
  )
  check(
    'Markdown shortcut captures source including formatting markers',
    evaluate(
      `return [...document.querySelectorAll('[aria-label="Notebook comments"] blockquote')].at(-1).textContent === ${JSON.stringify('😀 **first**\nsecond')};`
    )
  )
  check(
    'Markdown draft preserves editor focus role',
    evaluate(`
    return JSON.parse(localStorage.getItem('runme/notebook-active-cells'))[${JSON.stringify(fixture.uri)}].focusRole === 'editor';
  `)
  )
  browser('find', 'role', 'button', 'click', '--name', 'Open Logs', '--exact')
  browser(
    'find',
    'role',
    'tab',
    'click',
    '--name',
    'editor-range-comments.runme',
    '--exact'
  )
  browser('wait', markdownInput)
  check('Returning to the notebook restores Markdown source editing', true)
  check(
    'Markdown draft visibly preserves source line breaks',
    evaluate(`
    const quote = [...document.querySelectorAll('[aria-label="Notebook comments"] blockquote')].at(-1);
    const style = getComputedStyle(quote);
    return style.whiteSpace === 'pre-wrap' && quote.getBoundingClientRect().height >= 2 * parseFloat(style.lineHeight);
  `)
  )
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-markdown-draft.png')
  )
  // The draft must retain the immutable revision even when the editor changes.
  browser('focus', markdownInput)
  await inputPage.keyboard.press('ControlOrMeta+a')
  await inputPage.keyboard.insertText('# Changed after opening comment draft')
  submit('Markdown selection comment')
  browser(
    'wait',
    '--fn',
    `document.body.textContent.includes('Outdated anchor')`
  )
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-saved.png')
  )

  browser('reload')
  browser('wait', codeInput)
  browser(
    'wait',
    '--fn',
    `document.body.textContent.includes('Markdown selection comment')`
  )
  const persisted = evaluate(`
    const db = window.app.localNotebooks;
    const comments = await db.listOperationLogComments(${JSON.stringify(fixture.uri)});
    return comments.map(comment => ({content:comment.content,view:JSON.parse(comment.anchor).runme}));
  `)
  writeFileSync(
    join(output, 'scenario-editor-range-comments-anchors.json'),
    JSON.stringify(persisted, null, 2)
  )
  check('Both comments survive reload', persisted.length === 2)
  for (const [index, content] of [
    'Code selection comment',
    'Markdown selection comment',
  ].entries()) {
    const view = persisted.find((entry: any) => entry.content === content)?.view
    const anchor = view?.anchors?.[0]
    const start = index === 0 ? 1 : sources[1].indexOf('😀')
    check(
      `${content}: immutable Unicode source range`,
      anchor?.kind === 'cell' &&
        anchor.surface === 'source' &&
        anchor.range?.unit === 'unicode-code-point' &&
        anchor.range.start_index === start &&
        anchor.range.end_index === Array.from(sources[index]).length &&
        view.anchorSources[0].source === sources[index]
    )
  }
  check(
    'Later Markdown edit does not retarget the comment',
    evaluate(
      `return document.body.textContent.includes('Changed after opening comment draft') && document.body.textContent.includes('Outdated anchor');`
    )
  )
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-reloaded.png')
  )
} catch (error) {
  failed++
  console.log(`[FAIL] ${error}`)
} finally {
  try {
    browser('record', 'stop')
  } catch (error) {
    failed++
    console.log(`[FAIL] Recording: ${error}`)
  }
  await inputBrowser?.close()
  if (!keepOpen)
    try {
      browser('close')
    } catch {
      /* Preserve the test result. */
    }
}
console.log(`Movie: ${movie}`)
console.log(
  `Assertions: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`
)
process.exitCode = failed ? 1 : 0
