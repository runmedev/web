import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

// A dedicated test browser is recommended; do not use a personal browser profile.
const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5197'
const output = path.resolve('test/browser/test-output/single-origin-bundle')

/** Exercise the actual production WebMCP tools without adding a test API to the app. */
export async function runSingleOriginBundle() {
  await mkdir(output, { recursive: true })
  // Detect dormant CDN fallbacks too: successful local loads would hide them.
  for (const file of await readdir('dist')) {
    if (!/\.(js|css|html)$/.test(file)) continue
    const source = await readFile(path.join('dist', file), 'utf8')
    assert(
      !source.includes('https://apis.google.com/js/api.js'),
      `Google loader remains in ${file}`
    )
    assert(
      !source.includes('https://esm.sh/'),
      `Excalidraw CDN fallback remains in ${file}`
    )
    assert(
      !/url\(["']?https?:/i.test(file.endsWith('.css') ? source : ''),
      `Remote CSS asset in ${file}`
    )
  }
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    timeout: 20000,
    args: [
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  })
  try {
    for (const failure of ['abort', 'stall'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 960 },
        recordVideo: { dir: output, size: { width: 1280, height: 960 } },
      })
      const external: string[] = [],
        requests: string[] = [],
        errors: string[] = []
      const failedAssets: string[] = []
      context.on('response', (response) => {
        if (response.status() >= 400)
          failedAssets.push(`${response.status()} ${response.url()}`)
      })
      context.on('requestfailed', (request) =>
        console.log(
          'Failed request',
          request.url(),
          request.failure()?.errorText
        )
      )
      context.on('request', (request) => {
        const url = request.url()
        requests.push(url)
        if (
          /^https?:/.test(url) &&
          new URL(url).origin !== new URL(base).origin
        )
          external.push(url)
      })
      await context.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === new URL(base).origin)
          return route.continue()
        if (failure === 'abort') return route.abort()
        // Leave the intercepted request pending until context teardown.
      })
      await context.addInitScript(() => {
        // Exercise the download fallback without a native OS file picker in CI.
        Object.defineProperty(window, 'showSaveFilePicker', {
          value: undefined,
          configurable: true,
        })
        delete (window as any).showOpenFilePicker
        const tools = new Map<string, any>()
        ;(window as any).__bundleTools = tools
        Object.defineProperty(document, 'modelContext', {
          configurable: true,
          value: {
            registerTool(tool: any, options?: { signal?: AbortSignal }) {
              tools.set(tool.name, tool)
              options?.signal?.addEventListener('abort', () => {
                if (tools.get(tool.name) === tool) tools.delete(tool.name)
              })
            },
          },
        })
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => {
        errors.push(error.message)
        console.error('Page error:', error.message)
      })
      await page.goto(`${base}/?session=bundle-${failure}`, {
        waitUntil: 'domcontentloaded',
      })
      console.log(failure, 'DOM loaded', await page.title())
      await page
        .getByRole('button', { name: 'Open App Console', exact: true })
        .waitFor({ timeout: 60000 })
      await page.waitForFunction(
        () => (window as any).__bundleTools?.has('ExecuteCode'),
        undefined,
        { timeout: 15000 }
      )
      async function execute(code: string) {
        let result = await page.evaluate(
          async (code) =>
            JSON.parse(
              await (window as any).__bundleTools
                .get('ExecuteCode')
                .execute({ code, timeoutMs: 1000 })
            ),
          code
        )
        while (result.status === 'running' || result.status === 'queued') {
          result = await page.evaluate(
            async (id) =>
              JSON.parse(
                await (window as any).__bundleTools
                  .get('GetExecuteCodeOperation')
                  .execute({ operationId: id, waitMs: 1000 })
              ),
            result.operationId
          )
        }
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        return result.output.events.map((e: any) => e.text).join('')
      }
      console.log(failure, 'app and tools ready')
      const seeded = await execute(`
        const d=await notebooks.createLocal('single-origin.runme');
        await notebooks.appendCell({target:{uri:d.handle.uri},kind:'code',languageId:'typescript',value:'const answer: number = 42'});
        await notebooks.show(d.handle.uri);
        console.log(d.handle.uri);
        const help=await documentation.get('getting-started');
        if(!help.includes('# Getting Started')) throw new Error('Bundled help missing');
      `)
      assert.match(seeded, /local:\/\/file\//)
      const notebookUri = seeded.match(/local:\/\/file\/[^\s]+/)![0]
      console.log(failure, 'notebook and help ready')
      await page.locator('.monaco-editor').first().waitFor({ timeout: 60000 })
      await page.screenshot({
        path: path.join(output, `${failure}-editor.png`),
      })
      // Notebook edits are debounced. Wait for the durable-save condition before
      // simulating a reload, rather than assuming a mutation response means saved.
      await execute(
        `const deadline=Date.now()+10000; while(!(await documents.get(${JSON.stringify(notebookUri)})).content.includes('const answer: number = 42')) { if(Date.now()>deadline) throw new Error('Local save did not finish'); await new Promise(resolve=>setTimeout(resolve,100)); }`
      )
      // Excalidraw receives real locally persisted scene data through the public document API.
      await execute(`
        const d=await notebooks.createLocal('single-origin.excalidraw');
        await documents.update(d.handle.uri, JSON.stringify({type:'excalidraw',version:2,source:'test',elements:[{id:'local-text',type:'text',x:100,y:100,width:220,height:25,angle:0,strokeColor:'#222222',backgroundColor:'transparent',fillStyle:'solid',strokeWidth:1,strokeStyle:'solid',roughness:1,opacity:100,groupIds:[],frameId:null,roundness:null,seed:1,version:1,versionNonce:1,isDeleted:false,boundElements:null,updated:1,link:null,locked:false,text:'Runme local fonts',originalText:'Runme local fonts',fontSize:20,fontFamily:5,textAlign:'left',verticalAlign:'top',containerId:null,lineHeight:1.25,autoResize:true}],appState:{viewBackgroundColor:'#ffffff'},files:{}}), {mimeType:'application/vnd.excalidraw+json'});
        await notebooks.show(d.handle.uri);
      `)
      console.log(failure, 'diagram created')
      await page
        .getByTestId('excalidraw-document-canvas')
        .waitFor({ timeout: 30000 })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await page.screenshot({
        path: path.join(output, `${failure}-excalidraw.png`),
      })
      await page.getByTestId('main-menu-trigger').click()
      await page.getByTestId('image-export-button').click()
      for (const format of ['PNG', 'SVG']) {
        const [saved] = await Promise.all([
          page.waitForEvent('download', { timeout: 20000 }),
          page
            .getByRole('dialog')
            .getByRole('button', { name: `Export to ${format}`, exact: true })
            .click(),
        ])
        await saved.saveAs(
          path.join(output, `${failure}-diagram.${format.toLowerCase()}`)
        )
        const bytes = await readFile(
          path.join(output, `${failure}-diagram.${format.toLowerCase()}`)
        )
        assert(bytes.length > 100, `${format} export is empty`)
        if (format === 'PNG')
          assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
        else assert(bytes.toString().includes('<svg'), 'SVG export is invalid')
      }
      await page.keyboard.press('Escape')
      // Wait for actual precache completion, then prove help and saved data survive offline reload.
      await page.evaluate(async () => {
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) =>
            setTimeout(
              async () =>
                reject(
                  new Error(
                    'Service worker not ready: ' +
                      JSON.stringify(
                        (await navigator.serviceWorker.getRegistrations()).map(
                          (r) => ({
                            scope: r.scope,
                            installing: r.installing?.state,
                            waiting: r.waiting?.state,
                            active: r.active?.state,
                          })
                        )
                      )
                  )
                ),
              20000
            )
          ),
        ])
      })
      await context.setOffline(true)
      await page.reload({ waitUntil: 'domcontentloaded' })
      console.log(failure, 'offline reloaded', await page.title())
      await page.waitForFunction(
        () => (window as any).__bundleTools?.has('ExecuteCode'),
        undefined,
        { timeout: 15000 }
      )
      await execute(
        `const persisted=await documents.get(${JSON.stringify(notebookUri)}); if(!persisted.content.includes('const answer: number = 42')) throw new Error('Durable local edit lost'); await notebooks.show(${JSON.stringify(notebookUri)}); const help=await documentation.get('getting-started');if(!help.includes('# Getting Started')) throw new Error('Offline help missing');`
      )
      await page.screenshot({
        path: path.join(output, `${failure}-offline.png`),
      })
      await context.setOffline(false)
      assert.deepEqual(
        failedAssets,
        [],
        'All requested local assets must be present'
      )
      assert.equal(
        external.length,
        0,
        `External requests: ${external.join('\n')}`
      )
      assert.deepEqual(errors, [])
      await writeFile(
        path.join(output, `${failure}-network.json`),
        JSON.stringify({ external, requests, errors }, null, 2)
      )
      const video = page.video()
      await context.close()
      if (video) {
        const destination = path.join(output, `${failure}.webm`)
        await video.saveAs(destination)
        console.log(`Movie: ${destination}`)
      }
    }
  } finally {
    await browser.close()
  }
  console.log(
    'PASS: fresh production app, Monaco, local notebook, bundled help and Excalidraw with external traffic blocked/stalled'
  )
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSingleOriginBundle().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
