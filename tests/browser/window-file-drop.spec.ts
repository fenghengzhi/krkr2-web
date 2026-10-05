import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { solidBmp } from '../helpers/archive-patch.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

const program = String.raw`
System.exitOnWindowClose=false;
var dropEvents=[],dropTrace=[],lastDropArray=null,unexpectedLayerDrops=0;
var dropScope=Storages.getFullPath("unchanged.txt");
function dropCheck(value,message){if(!value)throw new Exception("drop-proof:"+message);}
class DropWindow extends Window {
  var tag,paint;
  function DropWindow(tag,left){
    super.Window();this.tag=tag;caption="Drop "+tag;setPos(left,0);visible=true;
    paint=new Layer(this,null);add(paint);paint.setSize(96,64);paint.fillRect(0,0,96,64,0xff203040);
    paint.onFileDrop=function(files){global.unexpectedLayerDrops++;};
    var tools=new MenuItem(this,"Drop tools"),item=new MenuItem(this,"Menu item");menu.add(tools);tools.add(item);
    setInnerSize(96,64);
  }
  function onFileDrop(files){
    global.lastDropArray=files;
    super.onFileDrop(files);
  }
  function action(event){
    if(event.type!="onFileDrop")return;
    dropCheck(event.target===this && event.files===global.lastDropArray,"action/Array identity");
    dropCheck(event.files instanceof "Array","native Array");
    var names=[],values=[];
    for(var i=0;i<event.files.count;i++){
      var path=event.files[i],name=Storages.extractStorageName(path),ext=Storages.extractStorageExt(path);
      names.add(name);dropCheck(Storages.getPlacedPath(path)==path,"canonical path");
      if(ext==".txt")values.add([].load(path,"utf-8")[0]);
      else if(ext==".bmp"){
        var image=new Layer(this,paint);image.loadImages(path);
        var pixel=image.getMainPixel(1,1);values.add("bmp:"+pixel);
        paint.fillRect(0,0,96,64,0xff000000|pixel);invalidate image;
      }else if(ext==".xp3")values.add("archive:"+Scripts.evalStorage(path+">value.tjs"));
      else values.add("raw");
    }
    dropCheck(Storages.getFullPath("unchanged.txt")==dropScope,"current directory changed");
    global.dropEvents.add(%["tag"=>tag,"paths"=>event.files,"values"=>values]);
    global.dropTrace.add("drop:"+tag+":"+global.dropEvents.count);
    Debug.message("file-drop-paths:"+global.dropEvents.count+":"+event.files.join("|"));
    Debug.message("file-drop:"+global.dropEvents.count+":"+tag+":"+names.join("|")+":"+values.join("|"));
  }
  function onClick(x,y){global.dropTrace.add("click:"+tag);Debug.message("file-drop-click:"+tag);}
}
var dropA=new DropWindow("A",0),dropB=new DropWindow("B",220);
function readonlyDrop(){
  var paths=dropEvents[0].paths,count=0,modes=["utf-8","utf-8a","utf-8o0"];
  for(var i=0;i<modes.count;i++){
    try{["changed"].save(paths[0],modes[i]);}catch(error){if(error.message.indexOf("read-only")<0)throw error;count++;}
  }
  try{dropA.paint.saveLayerImage(paths[1],"bmp");}catch(error){if(error.message.indexOf("read-only")<0)throw error;count++;}
  return count+"|"+[].load(paths[0],"utf-8")[0]+"|"+[].load(paths[2],"utf-8")[0];
}
`

type DropFile = { name: string; bytes: Uint8Array }
type DropProof = { requests: number; replies: Array<{ type?: string; value?: { status?: string } }>; events: unknown[] }
declare global { interface Window { fileDropProof: DropProof } }

async function observe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof: DropProof = { requests: 0, replies: [], events: [] }, ids = new Set<string>(),
      NativeWorker = window.Worker, post = NativeWorker.prototype.postMessage
    window.fileDropProof = proof
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker
        worker.addEventListener('message', (event) => {
          if (ids.delete(event.data?.id)) proof.replies.push(structuredClone(event.data))
        })
        return worker
      },
    })
    NativeWorker.prototype.postMessage = new Proxy(post, {
      apply(target, receiver, args) {
        const packet = args[0] as { id?: string; type?: string; argumentList?: Array<{ value?: unknown }> }
        if (packet?.type === 'APPLY' && packet.argumentList?.[0]?.value === 'dropFiles') {
          if (packet.id) ids.add(packet.id)
          proof.requests++
        }
        return Reflect.apply(target, receiver, args)
      },
    })
    document.addEventListener('drop', (event) => {
      proof.events.push({ trusted: event.isTrusted, types: [...(event.dataTransfer?.types ?? [])],
        files: [...(event.dataTransfer?.files ?? [])].map((file) => ({ name: file.name, size: file.size })),
        windowId: event.target instanceof Element ? event.target.closest('[data-window-id]')?.getAttribute('data-window-id') : null })
    }, true)
  })
}

/** Real File capabilities enter the actual App handler. The DragEvent itself
 * is authored by Playwright, not a physical OS file-manager gesture. */
async function drop(target: Locator, files: readonly DropFile[]): Promise<{ prevented: boolean; effect: string }> {
  return target.evaluate((element, files) => {
    const transfer = new DataTransfer()
    transfer.effectAllowed = 'copy'
    for (const file of files) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name))
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    element.dispatchEvent(event)
    const result = { prevented: event.defaultPrevented, effect: transfer.dropEffect }
    // Protected-mode lifetime must not be replaced by consulting DataTransfer
    // later, after the FIFO reaches this item.
    transfer.items.clear()
    return result
  }, files.map((file) => ({ name: file.name, bytes: [...file.bytes] })))
}

async function waitAdmission(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.fileDropProof.replies.length)).toBe(count)
  expect(await page.evaluate(() => window.fileDropProof.replies.map((reply) => reply.value?.status)))
    .toEqual(Array.from({ length: count }, () => 'accepted'))
}

async function finish(page: Page, info: TestInfo, stop: () => Promise<void>, failures: unknown[]): Promise<void> {
  try {
    await info.attach('file-drop-evidence', { contentType: 'application/json', body: JSON.stringify({
      scope: 'Actual File/DOM/Worker/TJS chain; authored DragEvent, not physical OS drag',
      proof: await page.evaluate(() => window.fileDropProof), logs: await page.locator('#logs').innerText(),
    }, null, 2) })
  } catch (error) { failures.push(error) }
  try { await stop() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'File drop scenario or cleanup failed', { cause: failures[0] })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const mode = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: live Window drops preserve reversed File identities, readonly bytes, BMP pixels and lazy archive paths`, async ({ page }, info) => {
    test.setTimeout(120000)
    await observe(page)
    const game = await launchWindowAttention(page, backend, binary, program), failures: unknown[] = [],
      canvas = game.surface('Drop A').locator('canvas[data-window-id]'),
      files = [{ name: 'same.txt', bytes: Buffer.from('first 雪') },
        { name: 'pixels.bmp', bytes: solidBmp(0x123456) }, { name: 'same.txt', bytes: Buffer.from('second') }]
    try {
      await evaluate(page, '(dropA.focusable=false,dropB.bringToFront(),0)', '0')
      expect(await drop(canvas, files)).toEqual({ prevented: true, effect: 'copy' })
      await waitAdmission(page, 1)
      await expect(page.getByText('file-drop:1:A:same.txt|pixels.bmp|same.txt:second|bmp:1193046|first 雪', { exact: true })).toBeVisible()
      await evaluate(page, '(dropEvents[0].paths[0]!==dropEvents[0].paths[2])+"|"+unexpectedLayerDrops+"|"+int(Storages.isExistentStorage("same.txt"))', '1|0|0')
      await evaluate(page, 'readonlyDrop()', '4|second|first 雪')
      let png: Buffer | undefined
      await expect.poll(async () => {
        png = await canvas.screenshot()
        const image = readScreenshotPng(png), at = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4
        return [...image.rgba.subarray(at, at + 4)]
      }).toEqual([18, 52, 86, 255])
      await info.attach('file-drop-bmp-display', { body: png!, contentType: 'image/png' })
      const archive = xp3Fixture({ 'value.tjs': '42' }).bytes
      expect(await drop(canvas, [{ name: 'bundle.xp3', bytes: archive }])).toEqual({ prevented: true, effect: 'copy' })
      await waitAdmission(page, 2)
      await expect(page.getByText('file-drop:2:A:bundle.xp3:archive:42', { exact: true })).toBeVisible()
      await evaluate(page, 'int(Storages.isExistentStorage("value.tjs"))', '0')
      await drop(canvas, [{ name: 'same.txt', bytes: Buffer.from('third') }])
      await waitAdmission(page, 3)
      await expect(page.getByText('file-drop:3:A:same.txt:third', { exact: true })).toBeVisible()
      await evaluate(page, '(dropEvents[0].paths[0]!==dropEvents[2].paths[0])+"|"+[].load(dropEvents[0].paths[0],"utf-8")[0]', '1|second')
      await evaluate(page, '(invalidate dropA,[].load(dropEvents[0].paths[2],"utf-8")[0])', 'first 雪')
      await expect(game.surface('Drop A')).toHaveCount(0)
      await expect(page.locator('#logs .error')).toHaveCount(0)
      for (const [index, file] of [...files, { name: 'bundle.xp3', bytes: archive }].entries())
        await info.attach(`file-drop-input-${index}-${file.name}`, { body: Buffer.from(file.bytes), contentType: 'application/octet-stream' })
      await info.attach('file-drop-input-hashes', { contentType: 'application/json', body: JSON.stringify(
        [...files, { name: 'bundle.xp3', bytes: archive }].map((file) => ({ name: file.name, bytes: file.bytes.length,
          sha256: createHash('sha256').update(file.bytes).digest('hex') }))) })
    } catch (error) { failures.push(error) }
    await finish(page, info, game.stop, failures)
  })

  test(`${mode}: disabled events retain distinct drops in DOM order ahead of a later real click`, async ({ page }, info) => {
    test.setTimeout(120000)
    await observe(page)
    const game = await launchWindowAttention(page, backend, binary, program), failures: unknown[] = [],
      canvas = game.surface('Drop A').locator('canvas[data-window-id]')
    try {
      await evaluate(page, '(System.eventDisabled=true,dropTrace.clear(),0)', '0')
      await drop(canvas, [{ name: 'one.txt', bytes: Buffer.from('one') }])
      await drop(canvas, [{ name: 'two.txt', bytes: Buffer.from('two') }])
      await waitAdmission(page, 2)
      await evaluate(page, 'dropEvents.count+"|"+dropTrace.count', '0|0')
      await canvas.click({ position: { x: 48, y: 32 } })
      await evaluate(page, '(System.eventDisabled=false,0)', '0')
      await expect(page.getByText('file-drop:2:A:two.txt:two', { exact: true })).toBeVisible()
      await expect(page.getByText('file-drop-click:A', { exact: true })).toBeVisible()
      await evaluate(page, 'dropTrace.join("|")', 'drop:A:1|drop:A:2|click:A')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await finish(page, info, game.stop, failures)
  })

  test(`${mode}: blocked, hidden and retired drop destinations do not receive files or restart the game`, async ({ page }, info) => {
    test.setTimeout(120000)
    await observe(page)
    const game = await launchWindowAttention(page, backend, binary, program), failures: unknown[] = [],
      a = game.surface('Drop A'), canvas = a.locator('canvas[data-window-id]'),
      file = [{ name: 'ignored.txt', bytes: Buffer.from('ignored') }]
    let stop = game.stop
    try {
      await page.locator('#pause').click()
      await expect(page.locator('#pause')).toHaveText('继续')
      expect(await drop(canvas, file)).toEqual({ prevented: true, effect: 'none' })
      await page.locator('#pause').click()
      await expect(page.locator('#pause')).toHaveText('暂停')
      await evaluate(page, '(dropA.visible=false,0)', '0')
      await expect(a).toBeHidden()
      expect(await drop(canvas, file)).toEqual({ prevented: true, effect: 'none' })
      await evaluate(page, '(dropA.visible=true,0)', '0')
      await expect(a).toBeVisible()
      await a.getByText('Drop tools', { exact: true }).click()
      // An owned menu control is not a Window file target; it cannot consume
      // Files as script input or let them navigate the page away.
      expect(await drop(a.locator('.game-window-menu'), file)).toEqual({ prevented: true, effect: 'none' })
      await page.keyboard.press('Escape')
      const oldCanvas = await canvas.elementHandle()
      expect(oldCanvas).not.toBeNull()
      await evaluate(page, '(invalidate dropA,0)', '0')
      await oldCanvas!.evaluate((node) => {
        const transfer = new DataTransfer(); transfer.items.add(new File(['late'], 'late.txt'))
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      })
      await oldCanvas!.dispose()
      await evaluate(page, 'dropEvents.count+"|"+int(isvalid dropB)', '0|1')
      expect(await page.evaluate(() => window.fileDropProof.requests)).toBe(0)
      await drop(game.surface('Drop B').locator('canvas[data-window-id]'), [{ name: 'live.txt', bytes: Buffer.from('live') }])
      await waitAdmission(page, 1)
      await expect(page.getByText('file-drop:1:B:live.txt:live', { exact: true })).toBeVisible()
      await evaluate(page, '(Debug.message("old-drop-path:"+dropEvents[0].paths[0]),0)', '0')
      const previous = (await page.getByText(/^old-drop-path:game:\/\/\.\//).innerText()).slice('old-drop-path:'.length)
      await stop()
      const fresh = await launchWindowAttention(page, backend, binary, program, [], true)
      stop = fresh.stop
      await evaluate(page, `dropEvents.count+"|"+int(Storages.isExistentStorage(${JSON.stringify(previous)}))`, '0|0')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await finish(page, info, stop, failures)
  })
}
