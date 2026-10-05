import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { stopGeometryPage } from '../helpers/window-geometry-browser.ts'

// These failures come from actual native/TJS consumers. No host callback,
// runtime formatter or translated error object is substituted by the test.
const source = String.raw`
System.exitOnWindowClose=false;
var messageWindow=new Window();messageWindow.caption="TVP messages";messageWindow.visible=true;
var messageRoot=new Layer(messageWindow,null);messageWindow.add(messageRoot);
messageRoot.setSize(160,96);messageRoot.fillRect(0,0,160,96,0xff315779);
var messageBinder=new Layer(messageWindow,messageRoot);messageWindow.add(messageBinder);messageBinder.type=ltBinder;
var messageChild=new Layer(messageWindow,messageRoot);messageWindow.add(messageChild);messageChild.setSize(4,3);
var fullscreenFailure="",fullscreenPreserved=false,timerRuns=0;
function messageFailure(which){
  try{
    if(which==0){var rows=[];rows.load("absent%2.txt");}
    else if(which==1){var rows=[];rows.loadStruct("absent-struct.bin");}
    else if(which==2)["unchanged"].save("absent-update.txt","utf-8o0");
    else if(which==3)messageRoot.setPos(1,0);
    else if(which==4)messageBinder.fillRect(0,0,1,1,0xffabcdef);
    else if(which==5)messageChild.copyRect(0,0,messageBinder,0,0,1,1);
    else if(which==6)Scripts.execStorage("absent-script.tjs");
    else throw new Exception("Unknown message failure case");
  }catch(error){return error.message;}
  return "NO_ERROR";
}
function messageState(){
  return [messageRoot.left,messageRoot.top,messageRoot.width,messageRoot.height,
    int(messageBinder.hasImage),int(messageChild.hasImage),int(Storages.isExistentStorage("absent-update.txt"))].join(",");
}
var messageEnter=new MenuItem(messageWindow,"Fullscreen");messageWindow.menu.add(messageEnter);
messageWindow.setInnerSize(160,96);
messageEnter.onClick=function(){
  global.messageWindow.fullScreen=true;var width=global.messageWindow.width;
  global.fullscreenFailure="NO_ERROR";
  try{global.messageWindow.width=width+1;}catch(error){global.fullscreenFailure=error.message;}
  global.fullscreenPreserved=global.messageWindow.width==width;
  global.Debug.message("tvp-fullscreen:"+global.fullscreenFailure+":"+int(global.fullscreenPreserved));
};
function messageTick(){
  messageTimer.enabled=false;global.timerRuns++;
  System.assignMessage("TVPCannotMovePrimary","async-latest:%%:%1");
  // Uncaught: the real Timer dispatch must carry this current holder through
  // the native exception and the event pump into the page's error log.
  messageRoot.left=1;
}
var messageTimer=new Timer(global,"messageTick");messageTimer.enabled=false;messageTimer.interval=25;
function armMessageTimer(){
  System.assignMessage("TVPCannotMovePrimary","async-stale");messageTimer.enabled=true;return 1;
}
Debug.message("tvp-default-storage:"+messageFailure(0));
Debug.message("tvp-default-layer:"+messageFailure(3));
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual Worker consumers use current native TVP holders and a new Session restores Japanese defaults`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const failures: unknown[] = [], workers: { url: string; closed: boolean }[] = [], sessions: { iteration: number; logs: string }[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    page.on('worker', (worker) => {
      if (!worker.url().includes('session.worker')) return
      const entry = { url: worker.url(), closed: false }; workers.push(entry)
      worker.on('close', () => { entry.closed = true })
    })
    try {
      for (let iteration = 0; iteration < 2; iteration++) {
        if (iteration) await page.locator('#clear-log').click()
        game = await launchWindowAttention(page, backend, binary, source, [], true)
        expect(workers).toHaveLength(iteration + 1)
        await expect(page.getByText('tvp-default-storage:ストレージ absent%2.txt を開くことができません', { exact: true })).toBeVisible()
        await expect(page.getByText('tvp-default-layer:プライマリレイヤは移動できません', { exact: true })).toBeVisible()
        await evaluate(page, 'messageState()', '0,0,160,96,0,1,0')
        if (iteration === 1) {
          await expect(page.locator('#logs .error')).toHaveCount(0)
          sessions.push({ iteration, logs: await page.locator('#logs').innerText() })
          await game.stop(); game = undefined
          await expect.poll(() => workers.map((worker) => worker.closed)).toEqual([true, true])
          await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
          continue
        }
        await evaluate(page, 'System.assignMessage("TVPCannotOpenStorage","storage[%1]|%1|%%|%2 日本語😀")', '1')
        await evaluate(page, 'System.assignMessage("TVPCannotFindStorage","find[%1]")', '1')
        await evaluate(page, 'System.assignMessage("TVPCannotMovePrimary","primary-live:%%:%1")', '1')
        await evaluate(page, 'System.assignMessage("TVPNotDrawableLayerType","destination-live")', '1')
        await evaluate(page, 'System.assignMessage("TVPSourceLayerHasNoImage","source-live")', '1')
        for (const [operation, name] of [[0, 'absent%2.txt'], [1, 'absent-struct.bin'], [2, 'absent-update.txt']] as const)
          await evaluate(page, `messageFailure(${operation})`, `storage[${name}]|${name}|%|%2 日本語😀`)
        await evaluate(page, 'messageFailure(3)', 'primary-live:%%:%1')
        await evaluate(page, 'messageFailure(4)', 'destination-live')
        await evaluate(page, 'messageFailure(5)', 'source-live')
        await evaluate(page, 'messageFailure(6)', 'find[absent-script.tjs]')
        await evaluate(page, 'messageState()', '0,0,160,96,0,1,0')
        await expect(page.locator('#logs .error')).toHaveCount(0)

        await evaluate(page, 'System.assignMessage("TVPInvalidPropertyInFullScreen","fullscreen-live:%%:%1")', '1')
        const surface = game.surface('TVP messages')
        await surface.getByRole('button', { name: 'Fullscreen', exact: true }).click()
        await expect(surface).toHaveClass(/game-window-fullscreen/)
        await expect(page.getByText('tvp-fullscreen:fullscreen-live:%%:%1:1', { exact: true })).toBeAttached()
        // Leave via the actual presentation control; fullscreen covers the
        // console, so neither evaluation nor Stop may click through it.
        await surface.getByRole('button', { name: '退出全屏', exact: true }).click()
        await expect(surface).not.toHaveClass(/game-window-fullscreen/)
        await evaluate(page, 'fullscreenFailure+","+int(fullscreenPreserved)', 'fullscreen-live:%%:%1,1')
        await expect(page.locator('#logs .error')).toHaveCount(0)

        await evaluate(page, 'armMessageTimer()', '1')
        await expect(page.locator('#status')).toHaveText('事件已停止')
        await expect(page.locator('#logs .error').filter({ hasText: 'async-latest:%%:%1' })).toHaveCount(1)
        await expect(page.locator('#logs .error')).toHaveCount(1)
        await expect(page.locator('#logs .error')).not.toContainText('async-stale')
        await evaluate(page, 'timerRuns+","+int(messageTimer.enabled)+","+int(System.eventDisabled)', '1,0,1')
        await evaluate(page, 'messageFailure(3)', 'async-latest:%%:%1')
        await evaluate(page, 'messageState()', '0,0,160,96,0,1,0')
        await evaluate(page, 'System.eventDisabled=false', '0')
        await expect(page.locator('#status')).toHaveText('运行中')
        sessions.push({ iteration, logs: await page.locator('#logs').innerText() })
        await game.stop(); game = undefined
        await expect.poll(() => workers.map((worker) => worker.closed)).toEqual(Array<boolean>(iteration + 1).fill(true))
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      }
    } catch (error) { failures.push(error) }
    try { await info.attach('actual-worker-tvp-messages', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, workers, sessions, logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      const exit = page.getByRole('button', { name: '退出全屏', exact: true })
      if (await exit.count()) await exit.first().click()
    } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop(); else await stopGeometryPage(page)
      await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'TVP message consumers or session cleanup failed', { cause: failures[0] })
  })
}

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: the real loader rejects missing or incompatible nativeMessages and recovers with the original manifest`, async ({ page }, info) => {
    test.setTimeout(120000)
    const bytes = await readFile('.generated/wasm/manifest.json'), hash = createHash('sha256').update(bytes).digest('hex'),
      match = (url: URL) => url.pathname === `/wasm/manifest-${hash.slice(0, 16)}.json`,
      workers: { url: string; closed: boolean }[] = [], errors: string[] = [],
      intercepted: { original: WasmManifest; served: WasmManifest }[] = [], failures: unknown[] = []
    let supplied: number | undefined
    page.on('worker', (worker) => {
      if (!worker.url().includes('session.worker')) return
      const entry = { url: worker.url(), closed: false }; workers.push(entry)
      worker.on('close', () => { entry.closed = true })
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    await page.context().route(match, async (route) => {
      try {
        const response = await route.fetch(), originalBytes = await response.body()
        if (!response.ok() || !originalBytes.equals(bytes)) throw new Error('Native TVP message manifest source mismatch')
        const original = JSON.parse(bytes.toString('utf8')) as WasmManifest, served = structuredClone(original)
        if (served.capabilities?.nativeMessages !== 1) throw new Error('Hosted build does not advertise nativeMessages=1')
        if (supplied === undefined) delete served.capabilities.nativeMessages
        else served.capabilities.nativeMessages = supplied
        intercepted.push({ original, served })
        await route.fulfill({ response, json: served })
      } catch (error) { errors.push(String(error)); await route.abort('failed') }
    })
    try {
      for (const [attempt, version] of ([undefined, 0, 2] as const).entries()) {
        supplied = version
        await page.locator('#files').setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain',
          buffer: Buffer.from('Debug.message("tvp-message-gate-started:"+int(System.assignMessage("TVPCannotOpenStorage","gate:%1")));') })
        await expect(page.locator('#logs')).toContainText('WASM manifest is missing native TVP message support')
        await expect(page.locator('#status')).toHaveText('运行失败')
        await expect(page.locator('#choose-files')).toBeEnabled()
        await expect(page.locator('#stop')).toBeDisabled()
        await expect(page.locator('#evaluate')).toBeDisabled()
        await expect(page.getByText('tvp-message-gate-started:1', { exact: true })).toHaveCount(0)
        await expect.poll(() => workers.map((worker) => worker.closed)).toEqual(Array<boolean>(attempt + 1).fill(true))
        expect(intercepted).toHaveLength(attempt + 1)
        const current = intercepted.at(-1)!
        expect({ ...current.served, capabilities: { ...current.served.capabilities, nativeMessages: 1 } }).toEqual(current.original)
        expect(errors).toEqual([])
        await page.locator('#clear-log').click()
      }
      await page.context().unroute(match)
      await page.locator('#files').setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(String.raw`
Debug.message("tvp-message-gate-recovered:"+int(System.assignMessage("TVPCannotOpenStorage","restored[%1]")));
try{var rows=[];rows.load("gate-absent.txt");}catch(error){Debug.message("tvp-message-gate-consumer:"+error.message);}
`) })
      await expect(page.getByText('tvp-message-gate-recovered:1', { exact: true })).toBeVisible()
      await expect(page.getByText('tvp-message-gate-consumer:restored[gate-absent.txt]', { exact: true })).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(workers).toHaveLength(4)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('native-tvp-messages-loader-gate', { contentType: 'application/json', body: JSON.stringify({
      backend, hash, intercepted, workers, errors, logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      await page.context().unroute(match)
      const exit = page.getByRole('button', { name: '退出全屏', exact: true })
      if (await exit.count()) await exit.first().click()
      await stopGeometryPage(page)
      await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'TVP message loader gate or cleanup failed', { cause: failures[0] })
  })
}
