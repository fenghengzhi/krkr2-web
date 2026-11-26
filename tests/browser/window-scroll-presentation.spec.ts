import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { build } from 'vite'

let script: string, styles: string
test.beforeAll(async () => {
  const result = await build({ configFile: false, publicDir: false, logLevel: 'error', build: {
    write: false, minify: false, lib: { entry: resolve('tests/helpers/window-scroll-host.ts'), formats: ['es'], fileName: () => 'window-scroll-host.mjs' },
  } }), output = (Array.isArray(result) ? result : [result]).flatMap((item) => 'output' in item ? item.output : []),
    entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing real Window scroll host bundle')
  script = entry.code
  styles = output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css')).map((item) =>
    item.type === 'asset' ? typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source) : '').join('\n')
  if (!styles) throw new Error('Missing real Window CSS')
})

test('repeated Window state preserves a pending DOM scroll while new positions, ranges and surfaces remain authoritative', async ({ page }, info) => {
  const failures: unknown[] = [], errors: string[] = [], records: unknown[] = []
  let installed = false
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/window-scroll-host.html', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/window-scroll-host.css"><style>body{margin:0}</style>' }))
  await page.route('**/window-scroll-host.mjs', (route) => route.fulfill({ contentType: 'text/javascript', body: script }))
  await page.route('**/window-scroll-host.css', (route) => route.fulfill({ contentType: 'text/css', body: styles }))
  try {
    await page.goto('/window-scroll-host.html')
    await page.evaluate(async () => {
      const path = '/window-scroll-host.mjs', module = await import(path) as typeof import('../helpers/window-scroll-host.ts')
      window.windowScrollHost = await module.installWindowScrollHost()
    })
    installed = true
    const repeated = await page.evaluate(() => window.windowScrollHost.repeatDuringLocalScroll())
    records.push({ repeated })
    expect(repeated.before).toEqual([30, 40]); expect(repeated.after).toEqual([30, 40])
    expect(repeated.eventsBefore).toBe(0); expect(repeated.eventsAfter).toBe(0)
    await expect.poll(() => page.evaluate(() => window.windowScrollHost.observations().map(({ x, y }) => [x, y])))
      .toEqual([[30, 40]])
    expect(await page.evaluate(() => window.windowScrollHost.publish(30, 40))).toEqual([30, 40])
    // There is no pending lock: a producer's different target at the same
    // revision applies immediately, even before any later scroll event.
    expect(await page.evaluate(() => window.windowScrollHost.publish(11, 13))).toEqual([11, 13])
    expect(await page.evaluate(() => window.windowScrollHost.shrink())).toEqual([0, 0])
    expect(await page.evaluate(() => window.windowScrollHost.restore())).toEqual([0, 0])
    expect(await page.evaluate(() => window.windowScrollHost.publish(30, 40))).toEqual([30, 40])
    expect(await page.evaluate(() => window.windowScrollHost.replace())).toEqual([7, 9])
    expect(errors).toEqual([])
  } catch (error) { failures.push(error) }
  try {
    await info.attach('window-scroll-presentation', { contentType: 'application/json', body: JSON.stringify({ records, errors,
      observations: installed ? await page.evaluate(() => window.windowScrollHost.observations()) : [],
      scope: 'Real DOM scroll and real host layout; repeated Window state is controlled. The existing full Worker cursor test retains all physical-pointer assertions.',
    }, null, 2) })
  } catch (error) { failures.push(error) }
  try { if (installed) await page.evaluate(() => window.windowScrollHost.dispose()) } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Window scroll presentation or cleanup failed', { cause: failures[0] })
})
