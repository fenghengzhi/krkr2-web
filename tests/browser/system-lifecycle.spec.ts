import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { maintenanceSource, observeMaintenance } from '../helpers/system-maintenance-browser.ts'
import { observeClientStopBoundary } from '../helpers/client-stop-embedding.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const mode = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: Stop retires an actual DOM geometry refresh with a withheld completed Worker reply`, async ({ page }, info) => {
    test.setTimeout(90000)
    await observeClientStopBoundary(page)
    const game = await launchWindowAttention(page, backend, binary, `
System.exitOnWindowClose=false;
var win=new Window();win.caption="Geometry retirement";win.setInnerSize(80,48);win.visible=true;
var root=new Layer(win,null);root.setSize(80,48);root.fillRect(0,0,80,48,0xff234567);
`), failures: unknown[] = []
    let stopRequested = false
    try {
      const surface = game.surface('Geometry retirement')
      await expect(surface).toHaveAttribute('data-geometry-revision', /^[1-9][0-9]*$/)
      await page.evaluate(() => window.clientStopBoundary.arm('refreshWindowGeometry'))
      // Change real CSS used by both the live header and its measurement tree.
      // The actual ResizeObserver initiates the refresh; only its completed
      // Worker reply is withheld, leaving an owned RPC pending during Stop.
      await page.addStyleTag({ content: '.game-window-header { height: 46px !important; }' })
      await expect.poll(() => page.evaluate(() => window.clientStopBoundary.read().workers
        .flatMap((worker) => worker.held).filter((reply) => reply.operation === 'refreshWindowGeometry').length)).toBe(1)
      await page.locator('#stop').dispatchEvent('click')
      stopRequested = true
      // The request is already in flight. A second click can race the button
      // becoming disabled after shutdown and prevent the retirement assertions.
      await game.waitForStopped()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const proof = await page.evaluate(() => window.clientStopBoundary.read()),
        workers = proof.workers.filter((worker) => worker.name.startsWith('krkr2-session-'))
      expect(workers).toHaveLength(1)
      expect(workers[0]!.terminated).toBe(1)
      expect(workers[0]!.held).toEqual([
        expect.objectContaining({ operation: 'refreshWindowGeometry', type: 'RAW' }),
      ])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      if (stopRequested) await game.waitForStopped()
      else await game.stop()
    } catch (error) { failures.push(error) }
    try { await info.attach('geometry-refresh-stop-boundary', {
      body: JSON.stringify(await page.evaluate(() => window.clientStopBoundary.read()), null, 2),
      contentType: 'application/json',
    }) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Geometry retirement or cleanup failed', { cause: failures[0] })
  })
  test(`${mode}: actual startup applies no-window policy to controller visibility, registered hidden Windows and errors`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const failures: unknown[] = [], observations: { name: string; status: string; logs: string }[] = []
    const cases = [
      { name: 'visible-controller', source: '', state: '运行中' },
      { name: 'hidden-controller', source: 'Debug.controller.visible=false;', state: '待机' },
      { name: 'disabled-policy', source: 'System.exitOnNoWindowStartup=false;Debug.controller.visible=false;', state: '运行中' },
      { name: 'hidden-window', source: 'Debug.controller.visible=false;var hidden=new Window();', state: '运行中' },
      { name: 'failed-startup', source: 'Debug.controller.visible=false;throw new Exception("startup-owned-failure");', state: '运行失败' },
    ]
    try {
      for (const scenario of cases) {
        await page.locator('#clear-log').click()
        const marker = 'lifecycle:' + scenario.name,
          source = scenario.source + `Debug.message(${JSON.stringify(marker)});`
        await page.locator('#files').setInputFiles([
          { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
            ? 'Scripts.compileStorage("lifecycle.tjs","savedata/lifecycle.cjs",false,true,false);Scripts.execStorage("savedata/lifecycle.cjs");'
            : 'Scripts.execStorage("lifecycle.tjs");') },
          { name: 'lifecycle.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
        ])
        if (scenario.name !== 'failed-startup') await expect(page.getByText(marker, { exact: true })).toBeVisible()
        else await expect(page.locator('#logs')).toContainText('startup-owned-failure')
        await expect(page.locator('#status')).toHaveText(scenario.state)
        if (scenario.name === 'visible-controller') await evaluate(page, 'int(System.exitOnNoWindowStartup)+","+int(Debug.controller.visible)', '1,1')
        if (scenario.name === 'disabled-policy') await evaluate(page, 'int(System.exitOnNoWindowStartup)+","+int(Debug.controller.visible)', '0,0')
        if (scenario.name === 'hidden-window') await evaluate(page, 'int(System.exitOnNoWindowStartup)+","+int(hidden.visible)', '1,0')
        observations.push({ name: scenario.name, status: await page.locator('#status').innerText(), logs: await page.locator('#logs').innerText() })
        if (scenario.state === '运行失败') {
          // Failed startup already retires the Player while preserving its
          // failure state. There is no running session left to stop.
          await expect(page.locator('#stop')).toBeDisabled()
          await expect(page.locator('#choose-files')).toBeEnabled()
          await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        } else if (scenario.state !== '待机') {
          if (!await page.locator('#debug-controller').isVisible()) await page.locator('#toggle-controller').click()
          await page.locator('#stop').click(); await expect(page.locator('#status')).toHaveText('待机')
        }
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      }
    } catch (error) { failures.push(error) }
    try { await info.attach('startup-policy', { body: JSON.stringify(observations), contentType: 'application/json' }) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) {
        if (!await page.locator('#debug-controller').isVisible()) await page.locator('#toggle-controller').click()
        await page.locator('#stop').click(); await expect(page.locator('#status')).toHaveText('待机')
      }
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Startup policy or cleanup failed', { cause: failures[0] })
  })
  test(`${mode}: the actual Worker compacts while events are disabled and stops its native watch on teardown`, async ({ page }, info) => {
    test.setTimeout(90000)
    await observeMaintenance(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const game = await launchWindowAttention(page, backend, binary, maintenanceSource, [], true), failures: unknown[] = []
    try {
      const count = () => page.evaluate(() => window.maintenanceProof.entries.filter((entry) => entry.kind === 'compact' && entry.level === 5).length)
      const before = await count()
      await page.waitForTimeout(4250)
      expect(await count()).toBe(before)
      await evaluate(page, '(System.removeContinuousHandler(continuous),0)', '0')
      await expect.poll(count, { timeout: 6500 }).toBeGreaterThan(before)
      await evaluate(page, '(System.eventDisabled=true,0)', '0')
      const disabled = await count()
      await expect.poll(count, { timeout: 6500 }).toBeGreaterThan(disabled)
      await evaluate(page, 'fakeCompacts', '0')
      const proof = await page.evaluate(() => window.maintenanceProof)
      expect(proof.dropped).toBe(0)
      expect(proof.entries.some((entry) => entry.level === 15)).toBe(false)
      await game.stop()
      const stopped = await count()
      await page.waitForTimeout(100)
      expect(await count()).toBe(stopped)
      await info.attach('automatic-maintenance', { body: JSON.stringify(proof), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    try { await game.stop(); await page.evaluate(() => window.closeMaintenanceProof()) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Automatic maintenance or cleanup failed', { cause: failures[0] })
  })
}
