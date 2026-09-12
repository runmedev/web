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

/** Inspect setup/storage directly, while UI actions use real browser events. */
async function evaluate(code: string): Promise<any> {
  return inputPage.evaluate(`(async () => { ${code} })()`)
}

/** Count every assertion so the suite can reject a partial walkthrough. */
function check(name: string, ok: boolean) {
  if (ok) passed++
  else throw new Error(name)
  console.log(`[PASS] ${name}`)
}

/** Save the actual draft through the visible comments panel. */
async function submit(content: string) {
  const draft = inputPage.locator(
    '[aria-label="Notebook comments"] textarea:not([placeholder])'
  )
  await draft.fill(content)
  await inputPage.getByRole('button', { name: 'Comment', exact: true }).click()
  await draft.waitFor({ state: 'hidden' })
}

try {
  browser('open', process.env.CUJ_FRONTEND_URL ?? 'http://localhost:5173')
  browser('record', 'start', movie)
  browser('wait', '--fn', 'Boolean(window.app?.localNotebooks)')
  // The pinned agent-browser native CLI treats chord strings as a single key.
  // Use Playwright for UI events and accessible locators, while retaining
  // the suite's existing browser session, recorder, and artifacts.
  const endpoint = JSON.parse(browser('get', 'cdp-url', '--json')).data.cdpUrl
  inputBrowser = await chromium.connectOverCDP(endpoint)
  const activeUrl = browser('get', 'url')
  const activePage = inputBrowser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url() === activeUrl)
  if (!activePage) throw new Error('Cannot find the recorded browser page')
  inputPage = activePage
  inputPage.setDefaultTimeout(15000)
  const fixture = await evaluate(`
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
  await inputPage.reload()
  const codeInput = '#code-action-editor-range-0 textarea'
  const markdownInput = '#markdown-action-editor-range-1 textarea'
  await inputPage.locator(codeInput).first().waitFor({ state: 'visible' })
  // From offset one through the end, crossing a surrogate pair and a newline.
  await inputPage.locator(codeInput).focus()
  for (const key of [
    'ControlOrMeta+a',
    'ArrowLeft',
    'ArrowRight',
    'Shift+ArrowDown',
    'Shift+End',
    'Shift+F10',
  ])
    await inputPage.keyboard.press(key)
  const menu = inputPage.getByRole('menuitem', {
    name: /^Comment on selection/,
  })
  await menu.waitFor({ state: 'visible' })
  check('Monaco context menu offers Comment on selection', true)
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-code-menu.png')
  )
  await menu.click()
  await inputPage
    .locator('[aria-label="Notebook comments"] blockquote')
    .first()
    .waitFor({ state: 'visible' })
  check(
    'Code draft contains only the selected multiline source',
    await evaluate(
      `return document.querySelector('[aria-label="Notebook comments"] blockquote').textContent === ${JSON.stringify(sources[0].slice(1))};`
    )
  )
  check(
    'Code draft visibly preserves source line breaks',
    await evaluate(`
    const quote = document.querySelector('[aria-label="Notebook comments"] blockquote');
    const style = getComputedStyle(quote);
    return style.whiteSpace === 'pre-wrap' && quote.getBoundingClientRect().height >= 2 * parseFloat(style.lineHeight);
  `)
  )
  await submit('Code selection comment')

  await inputPage.locator('#markdown-rendered-editor-range-1').dblclick()
  await inputPage.locator(markdownInput).first().waitFor({ state: 'visible' })
  await inputPage.locator(markdownInput).focus()
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
  await inputPage
    .locator('[aria-label="Notebook comments"] textarea:not([placeholder])')
    .first()
    .waitFor({ state: 'visible' })
  check(
    'Markdown shortcut captures source including formatting markers',
    await evaluate(
      `return [...document.querySelectorAll('[aria-label="Notebook comments"] blockquote')].at(-1).textContent === ${JSON.stringify('😀 **first**\nsecond')};`
    )
  )
  check(
    'Markdown draft preserves editor focus role',
    await evaluate(`
    return JSON.parse(localStorage.getItem('runme/notebook-active-cells'))[${JSON.stringify(fixture.uri)}].focusRole === 'editor';
  `)
  )
  await inputPage
    .getByRole('button', { name: 'Open Logs', exact: true })
    .click()
  await inputPage
    .getByRole('tab', { name: 'editor-range-comments.runme', exact: true })
    .click()
  await inputPage.locator(markdownInput).first().waitFor({ state: 'visible' })
  check('Returning to the notebook restores Markdown source editing', true)
  check(
    'Markdown draft visibly preserves source line breaks',
    await evaluate(`
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
  await inputPage.locator(markdownInput).focus()
  await inputPage.keyboard.press('ControlOrMeta+a')
  await inputPage.keyboard.insertText('# Changed after opening comment draft')
  await submit('Markdown selection comment')
  await inputPage.waitForFunction(
    `document.body.textContent.includes('Outdated anchor')`
  )
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-saved.png')
  )

  // Add another range on the same Markdown cell, this time on current source.
  // The old range remains outdated; selecting either card must not activate both.
  await inputPage.locator(markdownInput).focus()
  for (const key of [
    'ControlOrMeta+a',
    'ArrowLeft',
    'ArrowRight',
    'ArrowRight',
    'Shift+End',
    'ControlOrMeta+Alt+m',
  ])
    await inputPage.keyboard.press(key)
  await inputPage
    .locator('[aria-label="Notebook comments"] textarea:not([placeholder])')
    .first()
    .waitFor({ state: 'visible' })
  await submit('Current Markdown selection comment')

  await inputPage.reload()
  await inputPage.locator(codeInput).first().waitFor({ state: 'visible' })
  await inputPage.waitForFunction(
    `document.body.textContent.includes('Markdown selection comment')`
  )
  const persisted = await evaluate(`
    const db = window.app.localNotebooks;
    const comments = await db.listOperationLogComments(${JSON.stringify(fixture.uri)});
    return comments.map(comment => ({id:comment.id,content:comment.content,view:JSON.parse(comment.anchor).runme}));
  `)
  writeFileSync(
    join(output, 'scenario-editor-range-comments-anchors.json'),
    JSON.stringify(persisted, null, 2)
  )
  check('All three source comments survive reload', persisted.length === 3)
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
        anchor.selection_surface === 'source' &&
        anchor.range?.unit === 'unicode-code-point' &&
        anchor.range.start_index === start &&
        anchor.range.end_index === Array.from(sources[index]).length &&
        view.anchorSources[0].source === sources[index]
    )
  }
  const current = persisted.find(
    (entry: any) => entry.content === 'Current Markdown selection comment'
  )
  // Explicitly render the already-active Markdown cell before navigating back
  // through the persisted comment card, as a reader does after reopening.
  await inputPage.locator(markdownInput).focus()
  await inputPage.keyboard.press('Escape')
  await inputPage
    .locator('#markdown-rendered-editor-range-1')
    .first()
    .waitFor({ state: 'visible' })
  await inputPage
    .getByText('Current Markdown selection comment', { exact: true })
    .click()
  await inputPage.locator(markdownInput).first().waitFor({ state: 'visible' })
  await inputPage
    .locator('#markdown-action-editor-range-1 .runme-source-comment-underline')
    .first()
    .waitFor({ state: 'visible' })
  check(
    'Saved Markdown range navigation opens its decorated source editor',
    true
  )
  check(
    'Only the selected saved range is active',
    await evaluate(`
    const active = [...document.querySelectorAll('[aria-label="Notebook comments"] article[aria-current="true"]')];
    return active.length === 1 && active[0].id === ${JSON.stringify('editor-comment-' + current.id)};
  `)
  )
  check(
    'Later Markdown edit does not retarget the comment',
    await evaluate(
      `return document.body.textContent.includes('Changed after opening comment draft') && document.body.textContent.includes('Outdated anchor');`
    )
  )
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-reloaded.png')
  )
  // Preserve rendered-origin navigation too: source coordinates alone do not
  // identify which view the reader used when creating a comment.
  await inputPage.locator(markdownInput).focus()
  await inputPage.keyboard.press('Escape')
  const rendered = inputPage.locator('#markdown-rendered-editor-range-1')
  await rendered.waitFor({ state: 'visible' })
  const heading = rendered.locator('h1')
  const box = await heading.evaluate((element) => {
    const range = document.createRange()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode()
    while (text && !text.textContent?.includes('Changed'))
      text = walker.nextNode()
    if (!text) throw new Error('Rendered heading text is missing')
    const start = text.textContent!.indexOf('Changed')
    range.setStart(text, start)
    range.setEnd(text, start + 'Changed'.length)
    const rect = range.getBoundingClientRect()
    return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width }
  })
  await inputPage.mouse.move(box.x + 1, box.y)
  await inputPage.mouse.down()
  await inputPage.mouse.move(box.x + box.width - 1, box.y, { steps: 12 })
  await inputPage.mouse.up()
  await inputPage.mouse.click(box.x + box.width / 2, box.y, { button: 'right' })
  await inputPage
    .getByRole('button', { name: 'Comment on selected text', exact: true })
    .click()
  await submit('Rendered heading selection comment')
  await inputPage.reload()
  await inputPage
    .getByText('Rendered heading selection comment', { exact: true })
    .waitFor({ state: 'visible' })
  await rendered.dblclick()
  await inputPage.locator(markdownInput).first().waitFor({ state: 'visible' })
  await inputPage
    .getByText('Rendered heading selection comment', { exact: true })
    .click()
  await rendered.waitFor({ state: 'visible' })
  check(
    'Saved rendered selection returns to rendered Markdown from its editor',
    true
  )
  check(
    'Rendered navigation highlights the selected projected text',
    await evaluate(`
    const root = document.querySelector('#markdown-rendered-editor-range-1');
    const active = [...(CSS.highlights?.get('runme-comment-range-active') ?? [])];
    const fallback = [...root.querySelectorAll('[data-runme-comment-highlight=active]')];
    return [...active.map(range => range.toString()), ...fallback.map(el => el.textContent)]
      .includes('Changed') &&
      !document.querySelector('#markdown-action-editor-range-1 .monaco-editor');
  `)
  )
  browser(
    'screenshot',
    join(output, 'scenario-editor-range-comments-rendered.png')
  )
  // Whole-document feedback uses the same composer but has no cell/range target.
  const documentButton = inputPage.getByRole('button', {
    name: 'Comment on notebook',
    exact: true,
  })
  await documentButton.click()
  await inputPage
    .getByText('New comment on notebook', { exact: true })
    .waitFor({ state: 'visible' })
  check(
    'Document comment button is left of Review suggestions',
    await evaluate(`
    const toolbar = document.getElementById('notebook-comment-review-actions');
    const buttons = [...toolbar.querySelectorAll('button')];
    return buttons[0].getAttribute('aria-label') === 'Comment on notebook' &&
      buttons[1].textContent.includes('Review suggestions') &&
      buttons[0].getBoundingClientRect().right <= buttons[1].getBoundingClientRect().left;
  `)
  )
  check(
    'Whole-document composer has no selected-text quote',
    (await inputPage
      .locator('[data-comment-panel-item="draft"] blockquote')
      .count()) === 0
  )
  browser(
    'screenshot',
    join(output, 'scenario-whole-document-comment-draft.png')
  )
  await submit('Whole notebook feedback')
  await inputPage.reload()
  await inputPage
    .getByText('Whole notebook feedback', { exact: true })
    .waitFor({ state: 'visible' })
  const documentComment = await evaluate(`
    const comments = await window.app.localNotebooks.listOperationLogComments(${JSON.stringify(fixture.uri)});
    const comment = comments.find(c => c.content === 'Whole notebook feedback');
    return { content: comment.content, view: JSON.parse(comment.anchor).runme };
  `)
  check(
    'Whole-document comment survives reload with only a revision-bound notebook anchor',
    documentComment.view.anchors.length === 1 &&
      documentComment.view.anchors[0].kind === 'notebook' &&
      documentComment.view.anchors[0].version.kind === 'revision' &&
      !documentComment.view.anchors[0].cell_id
  )
  writeFileSync(
    join(output, 'scenario-whole-document-comment.json'),
    JSON.stringify(documentComment, null, 2)
  )
  browser(
    'screenshot',
    join(output, 'scenario-whole-document-comment-saved.png')
  )
} catch (error) {
  failed++
  console.log(`[FAIL] ${error}`)
  if (inputPage)
    writeFileSync(
      join(output, 'scenario-editor-range-comments-failure.html'),
      await inputPage.content().catch(() => 'Page unavailable')
    )
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
