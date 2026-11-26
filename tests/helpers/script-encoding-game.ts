import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, type Page, type TestInfo } from '@playwright/test'

/** Literal GBK characters in otherwise ASCII authored scripts. No product
 * decoder or platform encoder is used to manufacture the reference bytes. */
function gbk(text: string): Buffer {
  const bytes: number[] = []
  for (const c of text) {
    if (c === '中') bytes.push(0xd6, 0xd0)
    else if (c === '文') bytes.push(0xce, 0xc4)
    else if (c.charCodeAt(0) < 128) bytes.push(c.charCodeAt(0))
    else throw new Error('No literal GBK fixture byte for ' + c)
  }
  return Buffer.from(bytes)
}

const override = String.raw`[iscript]
Scripts.textEncoding="UTF-8";
global.encodedRuntime=Scripts.evalStorage("utf8-value.tjs");
Scripts.textEncoding="GBK";
[endscript]
`
export const encodingFirst = String.raw`[eval exp="f.encodedProgress=0"]
*choice|GBK opening
[cm][hr][nowait]OPENING [emb exp="global.encodedBoot"][endnowait]
[iscript]
global.encodedRendered=global.kag.historyLayer.currentLine;global.encodedVisits++;
[endscript]
[r][link target=*selected]Read chapter[endlink] / [link target=*override]Use UTF-8[endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.encodedProgress=7"]
[jump storage=chapter.ks target=*checkpoint]
*override
` + override + String.raw`[jump target=*choice]
*load
[load place=0 ask=false]
`
export const encodingChapter = String.raw`*checkpoint|GBK chapter
[cm][hr][nowait]CHAPTER 中文 [emb exp="f.encodedProgress"][endnowait]
[iscript]
global.encodedRendered=global.kag.historyLayer.currentLine;global.encodedVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*override]Use UTF-8[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.encodedProgress=99"]
[jump target=*checkpoint]
*override
` + override + String.raw`[jump target=*checkpoint]
*load
[load place=0 ask=false]
`
export const encodingObserver = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="encoding";kag.saveDataLocation=System.dataPath;
var encodedVisits=0,encodedRendered="",encodedRuntime="";
var encodedDefaultText=[].load("title.txt")[0],encodedDefaultScript=Scripts.evalStorage("gbk-value.tjs");
var encodedBom=Scripts.evalStorage("bom-value.tjs"),encodedExplicitMode=Scripts.evalStorage("utf8-value.tjs","utf-8");
function encodingReads(){
 return [global.encodedBoot,global.encodedDefaultText,global.encodedDefaultScript,global.encodedBom,
  global.encodedExplicitMode,global.encodedRuntime,Scripts.textEncoding].join("|");
}
function encodingState(){
 return [f.encodedProgress,global.encodedRendered,global.encodedVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status].join("|");
}
function encodingStoredState(){
 var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return [saved.user.encodedProgress,saved.core.mainConductor.curLabel].join("|");
}
Debug.message("script-encoding-game-ready");
`
export const encodingReadsExpected = (runtime = false) =>
  `中文|中文|中文|BOM 雪|UTF8 🎮|${runtime ? 'UTF8 🎮' : ''}|GBK`

export async function scriptEncodingFiles(binary: boolean) {
  const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
    sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  if (sha(original) !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The fixed original KAG template changed')
  const files = [
    { name: 'kag3_template.xp3', bytes: original },
    // Decode this opening before game code can change the converter. The
    // original KAG system contains CP932 scripts; the game selects that codec
    // explicitly while loading it, then its BOM-marked hook selects GBK.
    { name: 'startup.tjs', bytes: gbk('var encodedBoot="中文";Scripts.textEncoding="Shift_JIS";Scripts.execStorage("kag3_template.xp3>startup.tjs");') },
    { name: 'AfterInit2.tjs', bytes: Buffer.from('\ufeffScripts.textEncoding="GBK";' + (binary
      ? 'Scripts.compileStorage("encoded-observer.tjs",System.dataPath+"encoded-observer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"encoded-observer.cjs");'
      : 'Scripts.execStorage("encoded-observer.tjs");'), 'utf16le') },
    { name: 'first.ks', bytes: gbk(encodingFirst) }, { name: 'chapter.ks', bytes: gbk(encodingChapter) },
    { name: 'encoded-observer.tjs', bytes: gbk(encodingObserver) },
    { name: 'title.txt', bytes: gbk('中文\n') }, { name: 'gbk-value.tjs', bytes: gbk('"中文"') },
    { name: 'bom-value.tjs', bytes: Buffer.from('\ufeff"BOM 雪"', 'utf16le') },
    { name: 'utf8-value.tjs', bytes: Buffer.from('"UTF8 🎮"') },
  ]
  return { files: files.map(({ name, bytes }) => ({ name, mimeType: 'application/octet-stream', buffer: bytes })),
    evidence: files.map(({ name, bytes }) => ({ name, bytes: bytes.length, sha256: sha(bytes) })) }
}

export function scriptEncodingGame(page: Page, info: TestInfo) {
  const observations: unknown[] = [], errors: string[] = []
  let sequence = 0
  page.on('pageerror', (error) => errors.push(error.message))
  const canvas = page.locator('#stage canvas[data-window-id]')
  const read = async (expression: string) => {
    const prefix = `script-encoding-read-${++sequence}:`
    await expect(page.locator('#evaluate')).toBeEnabled()
    await page.evaluate((source) => {
      const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
      if (button.disabled) throw new Error('Script encoding observer is unavailable')
      input.focus({ preventScroll: true }); input.value = source; button.click()
    }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
    const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
    await expect(output).toBeVisible({ timeout: 5000 })
    const value = ((await output.textContent()) ?? '').slice(prefix.length)
    if (observations.length < 160) observations.push({ expression, value })
    return value
  }
  const state = async (progress: number, visits: number, choice = false) => {
    await expect.poll(() => read('encodingState()'), { timeout: 15000 }).toBe(choice
      ? `0|OPENING 中文|${visits}|*choice|3|0`
      : `${progress}|CHAPTER 中文 ${progress}|${visits}|*checkpoint|4|0`)
    await expect(page.locator('#logs .error')).toHaveCount(0)
  }
  const ready = async () => {
    await expect(page.getByText('script-encoding-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
    const exit = page.locator('.leave-fullscreen')
    if (await exit.isVisible()) await exit.click()
    await expect(page.locator('#status')).toHaveText('运行中')
    await expect(canvas).toHaveCount(1)
    await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
    expect(await read('encodingReads()')).toBe(encodingReadsExpected())
  }
  const clickLink = async (index: number, target: string) => {
    const fields = (await read(`(function(){var m=kag.current,l=m.links[${index}];
      var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
      if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
      for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
      return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`)).split('|')
    expect(fields).toHaveLength(6); expect(fields[4]).toBe(target); expect(fields[5]).toBe('0')
    const [x, y, width, height] = fields.slice(0, 4).map(Number)
    expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
    expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
    expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
    await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
    const box = await canvas.boundingBox(); expect(box).not.toBeNull()
    observations.push({ click: target, x, y, box })
    await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
  }
  const backup = async (label: string, binary: boolean) => {
    await page.locator('#save-format').selectOption('backup')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
    expect(await download.failure()).toBeNull()
    const path = await download.path(); expect(path).not.toBeNull()
    const bytes = await readFile(path!), data = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] }
    await info.attach(label, { body: bytes, contentType: 'application/json' })
    const slot = data.files.find((file) => file.path === 'savedata/encoding0.kdt')
    expect(slot).toBeDefined()
    const slotBytes = Buffer.from(slot!.base64, 'base64')
    expect(slotBytes.toString('utf16le')).toContain('encodedProgress')
    expect(slotBytes.toString('utf16le')).toContain('*checkpoint')
    if (binary) {
      const compiled = data.files.find((file) => file.path === 'savedata/encoded-observer.cjs')
      expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
    }
    observations.push({ backup: label, gameId: data.gameId, slotBytes: slotBytes.length,
      slotSha256: createHash('sha256').update(slotBytes).digest('hex') })
    return { gameId: data.gameId, slotBytes }
  }
  const stop = async () => {
    if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
    await expect(page.locator('#status')).toHaveText('待机')
    await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
  }
  const screenshot = async (name: string) => {
    await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
    await info.attach(name, { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
  }
  const finish = async (failures: unknown[], fixture: Awaited<ReturnType<typeof scriptEncodingFiles>>) => {
    const reports = [
      () => info.attach('script-encoding-observations', { body: JSON.stringify({ files: fixture.evidence, observations, errors,
        scope: 'A literal GBK BOM-less opening is read before any script sets the converter. Unchanged original UTF-8 KAG system scripts load under an explicit game setting; authored GBK scenarios then exercise default reads, BOM and explicit UTF-8 overrides. Only the authored observer is compiled.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('script-encoding-authored-source', { body: encodingFirst + '\n' + encodingChapter + '\n' + encodingObserver, contentType: 'text/plain' }),
      async () => info.attach('script-encoding-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      ...fixture.files.filter((file) => file.name !== 'kag3_template.xp3').map((file) =>
        () => info.attach('raw-' + file.name, { body: file.buffer, contentType: 'application/octet-stream' })),
    ]
    for (const report of reports) try { await report() } catch (error) { failures.push(error) }
    try { await stop(); expect(errors).toEqual([]) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Script encoding game or cleanup failed', { cause: failures[0] })
  }
  return { read, ready, state, clickLink, backup, stop, screenshot, finish }
}
