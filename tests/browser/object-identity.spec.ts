import { expect, test, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { prepareSystemPage, stopSystemPage, systemFiles } from '../helpers/web-system-core.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var identityWindow=new Window();identityWindow.caption="Identity capture";
identityWindow.setInnerSize(200,100);identityWindow.visible=true;
var identityRoot=new Layer(identityWindow,null);identityRoot.setSize(200,100);
identityRoot.fillRect(0,0,200,100,0xff203040);
var identityWindowMoves=0,identityWindowUps=0,identityRootMoves=0,identityRootDowns=0,identityRootUps=0,identityRootEnters=0;
identityWindow.onMouseMove=function(x,y,shift){Debug.message("identity:window-move:"+(++global.identityWindowMoves));};
identityWindow.onMouseUp=function(x,y,button,shift){Debug.message("identity:window-up:"+(++global.identityWindowUps));};
identityWindow.onKeyDown=function(key,shift){
  if(key==68){delete global.identityUpper;Debug.message("identity:external-owner-dropped");}
};
identityRoot.onMouseEnter=function(){Debug.message("identity:underlay-enter:"+(++global.identityRootEnters));};
identityRoot.onMouseMove=function(x,y,shift){Debug.message("identity:underlay-move:"+(++global.identityRootMoves));};
identityRoot.onMouseDown=function(x,y,button,shift){Debug.message("identity:underlay-down:"+(++global.identityRootDowns));};
identityRoot.onMouseUp=function(x,y,button,shift){Debug.message("identity:underlay-up:"+(++global.identityRootUps));};
class IdentityMouseLayer extends Layer {
  function IdentityMouseLayer(){
    super.Layer(global.identityWindow,global.identityRoot);
    setPos(10,10);setSize(70,50);fillRect(0,0,70,50,0xff90b0d0);visible=true;
  }
  function onMouseDown(x,y,button,shift){
    global.Debug.message("identity:upper-down");
    invalidate this;
    global.Debug.message("identity:upper-invalidated");
  }
  function onMouseMove(x,y,shift){global.Debug.message("identity:upper-move");}
  function onMouseUp(x,y,button,shift){global.Debug.message("identity:unexpected-invalid-up");}
}
var identityUpper=new IdentityMouseLayer();
`

interface IdentityPresentation {
  generation: number
  state: number
  move: number
  up: number
  logs: Record<string, number>
  underlay: { move: number; down: number; up: number; enter: number }
}
declare global { interface Window { objectIdentityPresentation: IdentityPresentation } }

/** Observe actual Session packets without delaying or mutating them. A state
 * after the Window callback log fences the underlay's negative drag assertion. */
async function observePresentation(page: Page) {
  await page.addInitScript(() => {
    const Channel = MessageChannel,
      evidence: IdentityPresentation = {
        generation: 0, state: 0, move: 0, up: 0, logs: {},
        underlay: { move: 0, down: 0, up: 0, enter: 0 },
      }
    window.objectIdentityPresentation = evidence
    window.MessageChannel = new Proxy(Channel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (!event.data || typeof event.data !== 'object') return
          const message = event.data as { type?: string; generation?: number; sequence?: number; text?: string }
          if (!Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.sequence)) return
          if (evidence.generation && evidence.generation !== message.generation) return
          evidence.generation = message.generation!
          if (message.type === 'state') evidence.state = message.sequence!
          if (message.type !== 'log' || typeof message.text !== 'string' || !message.text.startsWith('identity:')) return
          evidence.logs[message.text] = message.sequence!
          if (message.text.startsWith('identity:window-move:')) evidence.move = message.sequence!
          if (message.text.startsWith('identity:window-up:')) evidence.up = message.sequence!
          for (const kind of ['move', 'down', 'up', 'enter'] as const)
            if (message.text.startsWith(`identity:underlay-${kind}:`)) evidence.underlay[kind]++
        })
        return channel
      },
    })
  })
}

async function presentedLog(page: Page, text: string) {
  await expect(page.getByText(text, { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate((text) => {
    const evidence = window.objectIdentityPresentation, sequence = evidence.logs[text]
    return sequence !== undefined && evidence.state > sequence
  }, text)).toBe(true)
}

async function movePhysical(page: Page, canvas: Locator, x: number, y: number) {
  const previous = await page.evaluate(() => window.objectIdentityPresentation.move),
    bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width * x / 200, bounds!.y + bounds!.height * y / 100)
  await expect.poll(() => page.evaluate((previous) => {
    const evidence = window.objectIdentityPresentation
    return evidence.move > previous && evidence.state > evidence.move
  }, previous)).toBe(true)
}

async function preserveCleanup(failures: unknown[], cleanup: () => Promise<void>) {
  try { await cleanup() }
  catch (error) {
    if (failures.length) throw new AggregateError([...failures, error], 'Object identity browser scenario and cleanup failed')
    throw error
  }
}

for (const backend of ['asyncify', 'jspi'] as const) {
  test(`${backend}: production object identity capability rejection recovers with the exact original manifest`, async ({ page }, info) => {
    const setup = await prepareSystemPage(page, backend),
      bytes = await readFile(resolve('.generated/wasm/manifest.json')),
      hash = createHash('sha256').update(bytes).digest('hex'),
      path = `/wasm/manifest-${hash.slice(0, 16)}.json`,
      matches = (url: URL) => url.pathname === path,
      failures: unknown[] = [], routingErrors: string[] = [],
      records: { stage: string; fetchedSha256: string; servedSha256: string }[] = []
    let rejectIdentity = true
    await page.context().route(matches, async (route) => {
      try {
        const response = await route.fetch(), original = await response.body()
        expect(response.ok()).toBe(true)
        expect(original).toEqual(bytes)
        const manifest = JSON.parse(original.toString()) as WasmManifest
        expect(manifest.capabilities?.objectIdentity).toBe(1)
        if (rejectIdentity) delete manifest.capabilities!.objectIdentity
        const body = rejectIdentity ? Buffer.from(JSON.stringify(manifest)) : original
        records.push({
          stage: rejectIdentity ? 'missing-capability' : 'exact-original-restored',
          fetchedSha256: createHash('sha256').update(original).digest('hex'),
          servedSha256: createHash('sha256').update(body).digest('hex'),
        })
        await route.fulfill({ response, body })
      } catch (error) { routingErrors.push(String(error)); await route.abort('failed') }
    })
    try {
      const files = systemFiles(false, 'var w=new Window();w.setInnerSize(160,80);w.visible=true;var root=new Layer(w,null);root.setSize(160,80);Debug.message("identity:manifest-restored");')
      await page.locator('#files').setInputFiles(files)
      await expect(page.locator('#logs')).toContainText('WASM manifest is missing native object identity support')
      await expect(page.locator('#choose-files')).toBeEnabled()
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true])
      expect(records).toHaveLength(1)
      expect(records[0]!.servedSha256).not.toBe(hash)
      expect(routingErrors).toEqual([])

      rejectIdentity = false
      await page.locator('#files').setInputFiles(files)
      await expect(page.getByText('identity:manifest-restored', { exact: true })).toBeVisible()
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(1)
      expect(records).toHaveLength(2)
      expect(records[1]).toEqual({ stage: 'exact-original-restored', fetchedSha256: hash, servedSha256: hash })
      expect(routingErrors).toEqual([])
    } catch (error) { failures.push(error); throw error }
    finally {
      await preserveCleanup(failures, async () => {
        await page.context().unroute(matches)
        await info.attach('object-identity-manifest-intervention', {
          body: JSON.stringify({ backend, hash, path, records, routingErrors }), contentType: 'application/json',
        })
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      })
    }
  })

  test(`${backend}: source and bytecode real drags retain a self-invalidated capture until mouse-up`, async ({ page }, info) => {
    await observePresentation(page)
    for (const binary of [false, true]) {
      const game = await launchWindowAttention(page, backend, binary, source),
        surface = game.surface('Identity capture'), canvas = surface.locator('canvas[data-window-id]'),
        failures: unknown[] = []
      let pressed = false
      try {
        await canvas.scrollIntoViewIfNeeded()
        await canvas.focus()
        await expect(surface.locator('.game-text-input')).toBeFocused()
        await movePhysical(page, canvas, 30, 30)
        await page.mouse.down()
        pressed = true
        await presentedLog(page, 'identity:upper-invalidated')

        // Keep the real pointer and button unchanged. Drop the last external
        // reference through the Window's real key path after capture commits.
        await page.keyboard.press('KeyD')
        await presentedLog(page, 'identity:external-owner-dropped')
        const before = await page.evaluate(() => ({ ...window.objectIdentityPresentation.underlay }))
        expect(before.down).toBe(0)
        expect(before.up).toBe(0)
        await movePhysical(page, canvas, 160, 75)
        expect(await page.evaluate(() => window.objectIdentityPresentation.underlay)).toEqual(before)
        await expect(page.locator('#logs')).not.toContainText('identity:unexpected-invalid-up')

        const previousUp = await page.evaluate(() => window.objectIdentityPresentation.up)
        await page.mouse.up()
        pressed = false
        await expect.poll(() => page.evaluate((previous) => {
          const evidence = window.objectIdentityPresentation
          return evidence.up > previous && evidence.state > evidence.up
        }, previousUp)).toBe(true)
        const released = await page.evaluate(() => ({ ...window.objectIdentityPresentation.underlay }))
        expect(released).toEqual({ ...before, enter: before.enter + 1 })
        await movePhysical(page, canvas, 140, 70)
        expect(await page.evaluate(() => window.objectIdentityPresentation.underlay.move)).toBe(before.move + 1)
        await page.mouse.down()
        pressed = true
        await presentedLog(page, 'identity:underlay-down:1')
        await page.mouse.up()
        pressed = false
        await presentedLog(page, 'identity:underlay-up:1')
        await expect(page.locator('#logs')).not.toContainText('identity:unexpected-invalid-up')
        await info.attach(`object-identity-${binary ? 'bytecode' : 'source'}-real-mouse`, {
          body: JSON.stringify({ backend, binary, before, released, events: await page.evaluate(() => window.objectIdentityPresentation) }),
          contentType: 'application/json',
        })
      } catch (error) { failures.push(error); throw error }
      finally {
        await preserveCleanup(failures, async () => {
          if (pressed) await page.mouse.up()
          await game.stop()
        })
      }
    }
  })
}
