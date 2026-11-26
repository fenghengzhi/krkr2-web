import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { expect, type Page, type TestInfo } from '@playwright/test'
import { httpServer, type HttpFixture } from './http-server.ts'
import { kagGameControls } from './kag-game-controls.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

const story = String.raw`[eval exp="f.remoteProgress=0"]
*choice|Remote opening
[cm][hr][nowait]REMOTE PATCH [emb exp="f.remoteProgress"][endnowait]
[iscript]
global.remoteRendered=global.kag.historyLayer.currentLine;global.remoteVisits++;
[endscript]
[r][link target=*selected]Read chapter[endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.remoteProgress=7"]
[jump target=*checkpoint]
*checkpoint|Remote chapter
[cm][hr][nowait]REMOTE CHAPTER [emb exp="f.remoteProgress"][endnowait]
[iscript]
global.remoteRendered=global.kag.historyLayer.currentLine;global.remoteVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.remoteProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
`
const observer = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="manifest";kag.saveDataLocation=System.dataPath;
var remoteVisits=0,remoteRendered="",remoteLiteral=Scripts.evalStorage(System.exePath+"extras/prompt #1.tjs");
function remotePaths(){return [System.exePath,System.dataPath,Storages.getPlacedPath("startup.tjs"),
 Storages.getPlacedPath("first.ks"),global.remoteLiteral].join("|");}
function remoteState(){return [f.remoteProgress,global.remoteRendered,global.remoteVisits,kag.currentLabel,
 kag.current.numLinks,kag.conductor.status].join("|");}
function remoteStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return [saved.user.remoteProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("remote-manifest-game-ready");
`
export async function remoteManifestGame(binary: boolean, gameDirectory = '') {
  const base = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
    sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
  if (sha(base) !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The fixed original KAG template changed')
  const inputs = [
    { path: 'data.xp3', url: '/release/data.xp3', bytes: base },
    { path: 'patch.xp3', url: '/release/packages/update.bin', bytes: xp3Fixture({ 'first.ks': wide(story) }, { compressed: true }).bytes },
    { path: 'AfterInit2.tjs', url: '/release/AfterInit2.tjs', bytes: wide(binary
      ? 'Scripts.compileStorage(System.exePath+"observer.tjs",System.dataPath+"remote-observer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"remote-observer.cjs");'
      : 'Scripts.execStorage(System.exePath+"observer.tjs");') },
    { path: 'observer.tjs', url: '/release/observer.tjs', bytes: wide(observer) },
    { path: 'extras/prompt #1.tjs', url: '/release/extras/prompt%20%231.tjs', bytes: wide('"remote literal"') },
  ].map((file) => ({ ...file, path: gameDirectory + file.path })),
    manifest = Buffer.from(JSON.stringify({ version: 1, files: gameDirectory
      ? inputs.map((file) => ({ path: file.path, url: file.url.slice('/release/'.length) }))
      : ['data.xp3', { path: 'patch.xp3', url: 'packages/update.bin' }, 'AfterInit2.tjs', 'observer.tjs', 'extras/prompt #1.tjs'] })),
    invalid = Buffer.from(JSON.stringify({ version: 1, files: ['must-not-load.tjs', '../escape.tjs'] })),
    heldBytes = Buffer.from(JSON.stringify({ version: 1, files: ['not-started.tjs'] })),
    held: { seen: number; aborted: boolean; released: boolean; response?: ServerResponse } = { seen: 0, aborted: false, released: false },
    files: Record<string, HttpFixture> = {
      '/manifest': { bytes: Buffer.alloc(0), intercept: (_request, response) => {
        response.writeHead(302, { Location: '/release/catalog.json', 'Cache-Control': 'no-store' }).end(); return true
      } },
      '/release/catalog.json': { bytes: manifest, full: true },
      '/invalid/catalog.json': { bytes: invalid, full: true },
      '/held/catalog.json': { bytes: heldBytes, intercept: (_request, response) => {
        held.seen++; held.response = response
        response.on('close', () => { if (!response.writableFinished) held.aborted = true })
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': heldBytes.length, 'Cache-Control': 'no-store' })
        response.flushHeaders(); response.write(heldBytes.subarray(0, 1)); return true
      } },
    }
  for (const file of inputs) files[file.url] = { bytes: file.bytes, etag: '"' + sha(file.bytes) + '"' }
  const server = await httpServer(files)
  let closed = false
  return { server, held, manifest, inputs, source: story + '\n' + observer,
    evidence: inputs.map((file) => ({ path: file.path, url: file.url, bytes: file.bytes.length, sha256: sha(file.bytes) })),
    release() { held.released = true; if (held.response && !held.response.destroyed) held.response.end(heldBytes.subarray(1)) },
    retireManifest() {
      // Already opened game files stay available. Saving the current game
      // must use its frozen collection, not fetch either manifest URL again.
      for (const path of ['/manifest', '/release/catalog.json']) files[path] = {
        bytes: Buffer.alloc(0), intercept: (_request, response) => { response.writeHead(404).end(); return true },
      }
    },
    async close() { if (!closed) { closed = true; await server.close() } },
    get closed() { return closed },
  }
}

export async function chooseRemoteManifest(page: Page, binary: boolean) {
  await expect(page.locator('#remote-kind')).toHaveValue('file')
  await page.locator('#project-mode').selectOption('collection')
  await page.locator('#remote-kind').selectOption('manifest')
  await expect(page.locator('#project-mode')).toHaveValue('auto')
  if (binary) {
    await page.locator('#project-mode').selectOption('root')
    await page.locator('#project-root').fill('data.xp3>')
  }
}
export async function submitRemoteManifest(page: Page, url: string) {
  await page.locator('#remote-url').fill(url)
  await page.locator('#load-url').click()
}

export function remoteManifestUi(page: Page, info: TestInfo, gameDirectory = '') {
  const observations: unknown[] = [], errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const canvas = page.locator('#stage canvas[data-window-id]')
  const { read, clickLink } = kagGameControls(page, observations)
  const state = async (progress: number, visits: number, choice = false) => {
    await expect.poll(() => read('remoteState()'), { timeout: 15000 }).toBe(choice
      ? `0|REMOTE PATCH 0|${visits}|*choice|2|0`
      : `${progress}|REMOTE CHAPTER ${progress}|${visits}|*checkpoint|3|0`)
  }
  const ready = async () => {
    await expect(page.getByText('remote-manifest-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
    const leave = page.locator('.leave-fullscreen')
    if (await leave.isVisible()) await leave.click()
    await expect(page.locator('#status')).toHaveText('运行中')
    await expect(canvas).toHaveCount(1)
    await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
    const paths = ['', 'savedata/', 'data.xp3>startup.tjs', 'patch.xp3>first.ks'].map((path) => 'game://./' + gameDirectory + path)
    expect(await read('remotePaths()')).toBe([...paths, 'remote literal'].join('|'))
  }
  const backup = async (name: string, binary: boolean) => {
    await page.locator('#save-format').selectOption('backup')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
    expect(await download.failure()).toBeNull()
    const path = await download.path(); expect(path).not.toBeNull()
    const bytes = await readFile(path!), value = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
      saved = value.files.find((file) => file.path === gameDirectory + 'savedata/manifest0.kdt')
    await info.attach(name, { body: bytes, contentType: 'application/json' })
    expect(saved).toBeDefined()
    const slot = Buffer.from(saved!.base64, 'base64')
    expect(slot.toString('utf16le')).toContain('remoteProgress'); expect(slot.toString('utf16le')).toContain('*checkpoint')
    if (binary) {
      const compiled = value.files.find((file) => file.path === gameDirectory + 'savedata/remote-observer.cjs')
      expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
    }
    observations.push({ backup: name, gameId: value.gameId, slotSha256: createHash('sha256').update(slot).digest('hex') })
    return { gameId: value.gameId, slot }
  }
  const stop = async () => {
    if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(canvas).toHaveCount(0)
    await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
  }
  const screenshot = async (name: string) => {
    await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
    await info.attach(name, { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
  }
  const finish = async (failures: unknown[], fixture: Awaited<ReturnType<typeof remoteManifestGame>>, extra: unknown,
    retiredLoadFailure = false) => {
    for (const report of [
      () => info.attach('remote-manifest-observations', { body: JSON.stringify({ inputs: fixture.evidence, observations, errors, extra,
        requests: fixture.server.requests, transport: fixture.server.stats(),
        held: { seen: fixture.held.seen, aborted: fixture.held.aborted, released: fixture.held.released },
        scope: 'Unchanged original KAG system plus authored XP3 scenario and source/bytecode observer. Observations include the real loaded storage paths, chapter link targets and bookmark bytes when exported.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('remote-manifest-input.json', { body: fixture.manifest, contentType: 'application/json' }),
      () => info.attach('remote-manifest-authored-source', { body: fixture.source, contentType: 'text/plain' }),
      async () => info.attach('remote-manifest-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (retiredLoadFailure) {
        // Expected failed restart retains its error UI. Assert actual resource
        // retirement without requiring the normal Stop label to replace it.
        await expect(page.locator('#stop')).toBeDisabled()
        await expect(canvas).toHaveCount(0)
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      } else await stop()
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    fixture.release()
    try { await fixture.close() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Remote manifest game or cleanup failed', { cause: failures[0] })
  }
  return { read, ready, state, clickLink, backup, stop, screenshot, finish }
}
