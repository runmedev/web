import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

/** Exercise recovery with real cached app/worker bytes but no preference copy.
 * Only release-settings opens are stalled; notebook storage remains real. */
async function main() {
  const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5198'
  const output = 'test/browser/test-output/controlled-releases'
  await mkdir(output, { recursive: true })
  await fetch(base + '/test/promote?release=b', { method: 'POST' })
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  })
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto(base + '/recovery.html')
    await page.waitForFunction(() => Boolean((window as any).runmeVersions))
    const candidate = await page.evaluate(() =>
      (window as any).runmeVersions.prepareRecovery({
        kind: 'channel',
        name: 'latest',
      })
    )
    // No activation has occurred: there is no saved preference or storage target.
    await page.evaluate(() => caches.delete('runme-release-preferences-v1'))
    await page.addInitScript(() => {
      const open = indexedDB.open.bind(indexedDB)
      ;(window as any).__settingsAttempts = 0
      indexedDB.open = ((name: string, version?: number) => {
        if (name === 'runme-release-control') {
          ;(window as any).__settingsAttempts++
          return {} as IDBOpenDBRequest
        }
        return open(name, version)
      }) as typeof indexedDB.open
    })
    // The fallback must not need discovery: only installed code is available.
    await context.setOffline(true)
    await page.goto(base + '/?session=cached-fallback')
    await page.locator('#main-page').waitFor({ timeout: 60000 })
    assert.equal(
      await page.evaluate(
        () => (window as any).runmeRelease.active.manifest.releaseId
      ),
      candidate.releaseId
    )
    assert.equal(
      await page.evaluate(() => (window as any).__settingsAttempts),
      1
    )
    await page.screenshot({
      path: output + '/no-preferences-offline-fallback.png',
    })

    // Remove completion metadata in this disposable profile to exercise the
    // explicit channel button when no usable cached inventory can be selected.
    await context.setOffline(false)
    await page.evaluate(async () => {
      const prefs = await caches.open('runme-release-preferences-v1')
      await prefs.delete('/__runme-release-preferences')
      for (const name of await caches.keys()) {
        if (!name.startsWith('runme-release-v1-')) continue
        const cache = await caches.open(name)
        const id = name.slice('runme-release-v1-'.length)
        await cache.delete(`/__runme-startup/${id}`)
        await cache.delete(`/version/${id}/release.json`)
      }
    })
    await page.reload()
    await page
      .getByRole('button', { name: 'Try latest channel', exact: true })
      .waitFor({ timeout: 60000 })
    const attempts = await page.evaluate(
      () => (window as any).__settingsAttempts
    )
    await page
      .getByRole('button', { name: 'Try latest channel', exact: true })
      .click()
    await page.locator('#main-page').waitFor({ timeout: 60000 })
    assert.equal(
      await page.evaluate(() => (window as any).__settingsAttempts),
      attempts
    )
    assert.equal(
      await page.evaluate(
        async () => (await (window as any).runmeVersions.get()).selection.name
      ),
      'latest'
    )
    assert.equal(
      await page.evaluate(
        () => (window as any).runmeRelease.active.manifest.releaseId
      ),
      candidate.releaseId
    )
    await page.screenshot({
      path: output + '/latest-channel-with-blocked-settings.png',
    })
    // The standalone recovery page does not automatically select cached code.
    // A failed offline download must not fall back to another blocked IDB read.
    await page.evaluate(async () =>
      (await caches.open('runme-release-preferences-v1')).delete(
        '/__runme-release-preferences'
      )
    )
    await page.goto(base + '/recovery.html')
    await page
      .getByRole('button', { name: 'Try latest channel', exact: true })
      .waitFor({ timeout: 60000 })
    const beforeFailedDownload = await page.evaluate(
      () => (window as any).__settingsAttempts
    )
    await context.setOffline(true)
    await page
      .getByRole('button', { name: 'Try latest channel', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Try latest channel', exact: true })
      .waitFor({ timeout: 60000 })
    await page.waitForFunction(() =>
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes('Failed to fetch')
    )
    assert.equal(
      await page.evaluate(() => (window as any).__settingsAttempts),
      beforeFailedDownload
    )
    assert.deepEqual(errors, [])
    await writeFile(
      output + '/cached-fallback-result.json',
      JSON.stringify({
        passed: true,
        releaseId: candidate.releaseId,
        settingsAttempts: attempts,
      })
    )
    console.log(
      'PASS: no-preference cached startup works offline; latest-channel recovery does not retry IndexedDB'
    )
  } catch (error) {
    console.error(await page.locator('body').innerText().catch(String))
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
