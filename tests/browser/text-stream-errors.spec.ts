import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { exportSystemSaves, type SystemBackup } from '../helpers/web-system-core.ts'

const source = String.raw`
var win=new Window();win.caption="Text stream errors";win.setInnerSize(96,64);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(96,64);root.fillRect(0,0,96,64,0xff234567);
Storages.addAutoPath("assets/");
["baseline"].save("savedata/seed.txt","utf-8");
var loaded=["preserved"],decodedCount=0;
function readFailure(which,name){
  global.loaded=["preserved"];
  try{
    if(which==0)global.loaded.load(name);
    else if(which==1)Scripts.execStorage(name);
    else if(which==2)Scripts.evalStorage(name);
    else Scripts.compileStorage(name,"savedata/invalid-output.cjs",false,true,false);
  }catch(error){return error.message;}
  return "NO_ERROR";
}
function writerFailure(path,mode){
  try{["must-not-write"].save(path,mode);}catch(error){return error.message;}
  return "NO_ERROR";
}
function recoverText(mode,path){
  ["A日","second"].save(path,mode);
  return [].load(path,mode=="utf-8"?"utf-8":"").join("|");
}
function recoverScripts(){
  ["global.decodedCount++;"].save("savedata/good-script.tjs","c1");
  Scripts.execStorage("savedata/good-script.tjs");
  ["40+2"].save("savedata/good-expression.tjs","z");
  return decodedCount+","+Scripts.evalStorage("savedata/good-expression.tjs");
}
`

/** Independent zlib writer; only its checksum is corrupted. No product codec
 * constructs the invalid input or any expected exported bytes. */
function badCompressedScript(): Buffer {
  const text = Buffer.from('global.decodedCount++;', 'utf16le'),
    packed = deflateSync(text), bytes = Buffer.alloc(21 + packed.length)
  bytes.set([0xfe, 0xfe, 2, 0xff, 0xfe])
  bytes.writeBigUInt64LE(BigInt(packed.length), 5)
  bytes.writeBigUInt64LE(BigInt(text.length), 13)
  bytes.set(packed, 21)
  bytes[bytes.length - 1]! ^= 1
  return bytes
}
function saved(backup: SystemBackup, path: string): Buffer {
  const file = backup.files.find((entry) => entry.path === path)
  expect(file, `Actual exported file ${path}`).toBeDefined()
  return Buffer.from(file!.base64, 'base64')
}

for (const backend of ['asyncify', 'jspi'] as const) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual Worker text stream failures preserve caller names, Array contents and later valid writes`, async ({ page }, info) => {
    test.setTimeout(120000)
    const files = [
      { name: 'assets/unknown.txt', mimeType: 'application/octet-stream', buffer: Buffer.from([0xfe, 0xfe, 9, 0xff, 0xfe]) },
      { name: 'assets/checksum.txt', mimeType: 'application/octet-stream', buffer: badCompressedScript() },
      { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('preserved file\r\n') },
    ], failures: unknown[] = [], backups: SystemBackup[] = [], workers: { url: string; closed: boolean }[] = []
    page.on('worker', (worker) => {
      if (!/\/session\.worker[-.]/.test(new URL(worker.url()).pathname)) return
      const entry = { url: worker.url(), closed: false }
      workers.push(entry)
      worker.on('close', () => (entry.closed = true))
    })
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      game = await launchWindowAttention(page, backend, binary, source, files, true)
      await expect(game.surface('Text stream errors')).toBeVisible()
      await evaluate(page, 'System.assignMessage("TVPUnsupportedCipherMode","cipher[%1]|%1|%%|%2")', '1')
      await evaluate(page, 'System.assignMessage("TVPUnsupportedModeString","mode:%1|%%|%2")', '1')
      for (const name of ['unknown.txt', 'checksum.txt']) {
        for (let operation = 0; operation < 4; operation++) {
          // ScriptMgn resolves exec/eval first; Array.load and the Web compile
          // extension construct the reader with the original requested name.
          const requested = operation === 1 || operation === 2 ? `game://./assets/${name}` : name
          await evaluate(page, `readFailure(${operation},${JSON.stringify(name)})`, `cipher[${requested}]|${requested}|%|%2`)
          await evaluate(page, 'loaded.join("|")+","+decodedCount', 'preserved,0')
        }
      }
      await evaluate(page, 'Storages.isExistentStorage("savedata/invalid-output.cjs")', '0')
      await evaluate(page, 'writerFailure("savedata/blocked.txt","c0")', 'mode:unsupported cipher mode|%|%2')
      await evaluate(page, 'writerFailure("keep.txt","c9")', 'mode:unsupported cipher mode|%|%2')
      await evaluate(page, 'Storages.isExistentStorage("savedata/blocked.txt")', '0')
      await evaluate(page, '[].load("keep.txt","utf-8")[0]', 'preserved file')
      const beforeRecovery = await exportSystemSaves(page)
      backups.push(beforeRecovery)
      expect(beforeRecovery.files.map((file) => file.path).sort()).toEqual([
        'savedata/seed.txt', ...(binary ? ['savedata/window-attention.cjs'] : []),
      ])
      expect(saved(beforeRecovery, 'savedata/seed.txt')).toEqual(Buffer.from('baseline\r\n'))
      if (binary) expect(saved(beforeRecovery, 'savedata/window-attention.cjs').subarray(0, 4).toString('ascii')).toBe('TJS2')

      for (const [mode, name] of [['utf-8', 'utf8'], ['c1', 'simple'], ['z', 'compressed']] as const)
        await evaluate(page, `recoverText(${JSON.stringify(mode)},"savedata/${name}.txt")`, 'A日|second')
      await evaluate(page, 'recoverScripts()', '1,42')
      await evaluate(page, '(function(){Debug.message("text-stream-recovered");return decodedCount;})()', '1')
      const afterRecovery = await exportSystemSaves(page)
      backups.push(afterRecovery)
      expect(afterRecovery.files.map((file) => file.path).sort()).toEqual([
        'savedata/compressed.txt', 'savedata/good-expression.tjs', 'savedata/good-script.tjs',
        'savedata/seed.txt', 'savedata/simple.txt', 'savedata/utf8.txt', ...(binary ? ['savedata/window-attention.cjs'] : []),
      ].sort())
      expect(saved(afterRecovery, 'savedata/utf8.txt')).toEqual(Buffer.from('A日\r\nsecond\r\n'))
      expect([...saved(afterRecovery, 'savedata/simple.txt').subarray(0, 9)]).toEqual([254, 254, 1, 255, 254, 130, 0, 218, 154])
      for (const [path, content] of [['savedata/compressed.txt', 'A日\r\nsecond\r\n'], ['savedata/good-expression.tjs', '40+2\r\n']] as const) {
        const bytes = saved(afterRecovery, path)
        expect([...bytes.subarray(0, 5)]).toEqual([254, 254, 2, 255, 254])
        expect(bytes.readBigUInt64LE(5)).toBe(BigInt(bytes.length - 21))
        expect(bytes.readBigUInt64LE(13)).toBe(BigInt(Buffer.byteLength(content, 'utf16le')))
        expect(inflateSync(bytes.subarray(21), { maxOutputLength: 1024 })).toEqual(Buffer.from(content, 'utf16le'))
      }
      await expect(page.locator('#logs')).toContainText('text-stream-recovered')
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await expect(page.locator('#status')).toHaveText('运行中')
    } catch (error) { failures.push(error) }
    try {
      await info.attach('text-stream-files-and-exports', { body: JSON.stringify({
        inputs: files.map((file) => ({ name: file.name, bytes: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex') })),
        backups,
      }), contentType: 'application/json' })
      await info.attach('text-stream-worker-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect(page.locator('.game-text-input')).toHaveCount(0)
      await expect.poll(() => workers.map((worker) => worker.closed)).toEqual([true])
    } catch (error) { failures.push(error) }
    try { await info.attach('text-stream-retired-workers', { body: JSON.stringify(workers), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Text stream browser scenario or cleanup failed', { cause: failures[0] })
  })
}
