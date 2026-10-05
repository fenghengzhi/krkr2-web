import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { stopGeometryPage } from '../helpers/window-geometry-browser.ts'
import { observeRandomEntropy } from '../helpers/random-entropy-browser.ts'

const source = String.raw`
var win=new Window();win.caption="Random source";win.setInnerSize(80,48);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(80,48);root.fillRect(0,0,80,48,0xff345678);
var generators=[];
function explicitSeeds(){
  var a=new Math.RandomGenerator(1234),b=new Math.RandomGenerator(1234);
  var zero=new Math.RandomGenerator(void),zeroCopy=new Math.RandomGenerator(0);
  if(a.random32()!=b.random32()||zero.random64()!=zeroCopy.random64())throw "explicit seed changed";
  var saved=a.serialize(),copy=new Math.RandomGenerator(saved);
  for(var i=0;i<10;i++)if(a.random32()!=copy.random32())throw "state restore changed";
  Debug.message("random-proof:explicit");return 1;
}

function defaults(){
  for(var i=0;i<3;i++)generators.add(new Math.RandomGenerator());
  generators[0].randomize();
  Debug.message("random-proof:default");return generators[0].serialize().state.length;
}
function failedReseed(){
  var copy=new Math.RandomGenerator(generators[0].serialize()),failed=false;
  try{generators[0].randomize();}catch(e){failed=e.message.indexOf("RandomGenerator entropy source failed")>=0;}
  var same=generators[0].random64()==copy.random64();
  Debug.message("random-proof:failure");return failed&&same;
}
explicitSeeds();Debug.message("random-proof:startup");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real Worker entropy seeds defaults and survives provider failure and session replacement`, async ({ page }, info) => {
    test.setTimeout(120000)
    await observeRandomEntropy(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const failures: unknown[] = [], instances: string[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      for (let session = 0; session < 2; session++) {
        game = await launchWindowAttention(page, backend, binary, source, [], true)
        await expect.poll(() => page.evaluate(() => window.randomEntropyProof.entries.filter((entry) =>
          entry.kind === 'debug' && entry.text === 'random-proof:startup').length)).toBe(session + 1)
        const instance = await page.evaluate(() => window.randomEntropyProof.entries.filter((entry) =>
          entry.kind === 'debug' && entry.text === 'random-proof:startup').at(-1)!.instance)
        expect(instances).not.toContain(instance); instances.push(instance)
        const entropy = () => page.evaluate((instance) => window.randomEntropyProof.entries.filter((entry) =>
          entry.instance === instance && entry.kind === 'entropy'), instance)
        expect(await entropy()).toHaveLength(0)
        await evaluate(page, 'defaults()', '4992')
        await expect.poll(async () => (await entropy()).length).toBe(8)
        for (const entry of await entropy()) {
          expect(entry.length).toBe(16); expect(entry.cryptoCalls).toBe(1)
          expect(entry.cryptoBytes).toHaveLength(16); expect(entry.written).toEqual(entry.cryptoBytes)
          expect(entry.error).toBeUndefined()
        }
        await evaluate(page, 'explicitSeeds()', '1')
        await expect.poll(() => page.evaluate((instance) => window.randomEntropyProof.entries.filter((entry) =>
          entry.instance === instance && entry.kind === 'debug' && entry.text === 'random-proof:explicit').length, instance)).toBe(2)
        expect(await entropy()).toHaveLength(8)
        const request = `second-call-${session}`
        await page.evaluate(({ instance, request }) => window.armRandomEntropy(instance, 2, request), { instance, request })
        await expect.poll(() => page.evaluate((request) => window.randomEntropyProof.entries.some((entry) =>
          entry.kind === 'armed' && entry.request === request), request)).toBe(true)
        await evaluate(page, 'failedReseed()', '1')
        await expect.poll(async () => (await entropy()).length).toBe(10)
        const failed = (await entropy()).at(-1)!
        expect(failed.cryptoCalls).toBe(1); expect(failed.error).toContain('random-provider-injected-failure')
        expect(failed.written).toBeUndefined()
        await evaluate(page, '(generators[0].randomize(),generators[0].serialize().state.length)', '4992')
        await expect.poll(async () => (await entropy()).length).toBe(12)
        await game.stop(); game = undefined
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
        expect((await entropy()).filter((entry) => entry.error)).toHaveLength(1)
      }
      const proof = await page.evaluate(() => window.randomEntropyProof)
      expect(proof.dropped).toBe(0)
      for (const instance of instances)
        expect(proof.entries.filter((entry) => entry.instance === instance && entry.kind === 'entropy')).toHaveLength(12)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('actual-worker-random-entropy', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, instances, proof: await page.evaluate(() => window.randomEntropyProof), logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop(); else await stopGeometryPage(page)
      await page.evaluate(() => window.closeRandomEntropyProof())
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Random entropy or session cleanup failed', { cause: failures[0] })
  })
}

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: the real loader requires native entropy support and recovers with the exact hosted manifest`, async ({ page }, info) => {
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
        if (!response.ok() || !originalBytes.equals(bytes)) throw new Error('Native random manifest source mismatch')
        const original = JSON.parse(bytes.toString('utf8')) as WasmManifest, served = structuredClone(original)
        if (served.capabilities?.nativeRandom !== 1) throw new Error('Hosted build does not advertise nativeRandom=1')
        if (supplied === undefined) delete served.capabilities.nativeRandom
        else served.capabilities.nativeRandom = supplied
        intercepted.push({ original, served })
        await route.fulfill({ response, json: served })
      } catch (error) { errors.push(String(error)); await route.abort('failed') }
    })
    try {
      for (const [attempt, version] of ([undefined, 0, 2] as const).entries()) {
        supplied = version
        await page.locator('#files').setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain',
          buffer: Buffer.from('var r=new Math.RandomGenerator();Debug.message("random-gate-started");') })
        await expect(page.locator('#logs')).toContainText('WASM manifest is missing native random entropy support')
        await expect(page.locator('#status')).toHaveText('运行失败')
        await expect(page.locator('#choose-files')).toBeEnabled()
        await expect(page.locator('#stop')).toBeDisabled()
        await expect(page.locator('#evaluate')).toBeDisabled()
        await expect(page.getByText('random-gate-started', { exact: true })).toHaveCount(0)
        await expect.poll(() => workers.map((worker) => worker.closed)).toEqual(Array<boolean>(attempt + 1).fill(true))
        expect(intercepted).toHaveLength(attempt + 1)
        const current = intercepted.at(-1)!
        expect({ ...current.served, capabilities: { ...current.served.capabilities, nativeRandom: 1 } }).toEqual(current.original)
        expect(errors).toEqual([])
        await page.locator('#clear-log').click()
      }
      await page.context().unroute(match)
      await page.locator('#files').setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain',
        buffer: Buffer.from('var r=new Math.RandomGenerator();Debug.message("random-gate-recovered:"+r.serialize().state.length);') })
      await expect(page.getByText('random-gate-recovered:4992', { exact: true })).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      expect(workers).toHaveLength(4)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('native-random-loader-gate', { contentType: 'application/json', body: JSON.stringify({
      backend, hash, intercepted, workers, errors, logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      await page.context().unroute(match)
      await stopGeometryPage(page)
      await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Random loader gate or cleanup failed', { cause: failures[0] })
  })
}
