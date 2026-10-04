import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  exportSystemSaves,
  prepareSystemPage,
  stopSystemPage,
  type SystemBackup,
} from '../helpers/web-system-core.ts'

const prefix = 'text-writer-modes:'
const textFile = (name: string, source: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(source),
})
const assertion = String.raw`
function writerCheck(value,message){if(!value)throw new Exception("text-writer-modes:"+message);}
`
function files(binary: boolean, source: string) {
  return [
    textFile(
      'startup.tjs',
      binary
        ? 'Scripts.compileStorage("WriterModes.tjs","savedata/WriterModes.cjs",false,true,false);Scripts.execStorage("savedata/WriterModes.cjs");'
        : 'Scripts.execStorage("WriterModes.tjs");',
    ),
    textFile('WriterModes.tjs', assertion + source),
  ]
}
async function ready(page: Page, message: string) {
  await expect(page.getByText(prefix + message, { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
}
function saved(backup: SystemBackup, path: string) {
  const file = backup.files.find((file) => file.path === path)
  expect(file, `Export must include ${path}`).toBeDefined()
  return Buffer.from(file!.base64, 'base64')
}
function paths(binary: boolean, names: string[]) {
  return [
    ...names.map((name) => `savedata/${name}`),
    ...(binary ? ['savedata/WriterModes.cjs'] : []),
  ].sort()
}

const rejectedKinds = ['lines', 'array', 'dictionary', 'forced-text'] as const
const rejectionProgram = String.raw`
var rejectedKinds=["lines","array","dictionary","forced-text"],rejectedModes=["c0","c9","c01","bc0"];
for(var i=0;i<rejectedKinds.count;i++)["original:"+rejectedKinds[i]].save("savedata/keep-"+rejectedKinds[i]+".txt","utf-8");
function runRejectedSaves(){
  var errors=0,continued=0,detail=[];
  for(var kind=0;kind<rejectedKinds.count;kind++){
    for(var existing=0;existing<2;existing++){
      var label=rejectedKinds[kind],path="savedata/"+(existing?"keep-":"missing-")+label+".txt",caught=0,returned=0,errorText="";
      // The only host operation inside this try is the save under test. The
      // immediate sentinel must be correct before another host operation runs.
      try{
        if(kind==0 || kind==3)["must-not-write"].save(path,rejectedModes[kind]);
        else if(kind==1)[17,"must-not-write"].saveStruct(path,rejectedModes[kind]);
        else{var bad=%["value"=>17];(Dictionary.saveStruct incontextof bad)(path,rejectedModes[kind]);}
        returned=1;
      }catch(e){caught=1;errorText=e.message;}
      var sentinel=caught*10+returned;
      writerCheck(sentinel==10,"immediate-catch:"+label+":"+existing);
      writerCheck(errorText.indexOf("Unsupported text writer encoding ")>=0,"mode-error:"+label);
      errors++;
      var recovery="savedata/after-"+label+"-"+existing+".txt",expected="continued:"+label+":"+existing;
      [expected].save(recovery,"utf-8");
      writerCheck([].load(recovery,"utf-8")[0]==expected,"legal-save-after-catch");
      if(existing)writerCheck([].load(path,"utf-8")[0]=="original:"+label,"old-file-unchanged");
      else writerCheck(!Storages.isExistentStorage(path),"missing-file-not-created");
      continued++;detail.add(label+":"+existing+":"+sentinel);
    }
  }
  Debug.message("text-writer-modes:catch-detail:"+detail.join(","));
  return errors+":"+continued;
}
Debug.message("text-writer-modes:before-rejections");
`

// Explicit byte offsets are independent fixture expectations, not calls to the
// production mode parser. Every target remains a small, existing UTF-16 file.
const updates = [
  { name: 'replace', mode: '', offset: undefined },
  { name: 'zero', mode: 'o0', offset: 0 },
  { name: 'empty', mode: 'o', offset: 0 },
  { name: 'first-empty', mode: 'oo6', offset: 0 },
  { name: 'negative', mode: 'o-6', offset: 0 },
  { name: 'positive-sign', mode: 'o+6', offset: 0 },
  { name: 'nonzero', mode: 'o6', offset: 6 },
  { name: 'first-number', mode: 'o10o2', offset: 10 },
  { name: 'octal', mode: 'o010', offset: 8 },
] as const
const seedText = '0123456789ABCDEF\r\n'
const shortText = 'X\r\n'
const utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
const updateProgram = String.raw`
var updateNames=${JSON.stringify(updates.map(({ name }) => name))},updateModes=${JSON.stringify(updates.map(({ mode }) => mode))};
var counterPath="savedata/update-counter.txt",count=0;
if(Storages.isExistentStorage(counterPath))count=int([].load(counterPath,"utf-8")[0]);
for(var i=0;i<updateNames.count;i++){
  var path="savedata/update-"+updateNames[i]+".txt";
  if(!count){["0123456789ABCDEF"].save(path);["X"].save(path,updateModes[i]);}
  writerCheck([].load(path,updateModes[i])[0]=="X","offset-read:"+updateNames[i]+":"+count);
}
[string(++count)].save(counterPath,"utf-8");
Debug.message("text-writer-modes:updates:"+count);
`

const compressedModes = ['c2', 'c20', 'c0z', 'zc0', 'z9'] as const
const binaryModes = ['b', 'bc0', 'bc9', 'bz'] as const
const encodingProgram = String.raw`
var compressedModes=${JSON.stringify(compressedModes)},binaryModes=${JSON.stringify(binaryModes)};
for(var i=0;i<compressedModes.count;i++){
  var path="savedata/compressed-"+compressedModes[i]+".txt";
  ["40+2"].save(path,compressedModes[i]);
  writerCheck([].load(path)[0]=="40+2" && Scripts.evalStorage(path)==42,"compressed-script:"+compressedModes[i]);
}
["40+2"].save("savedata/simple.txt","c10");
writerCheck([].load("savedata/simple.txt")[0]=="40+2" && Scripts.evalStorage("savedata/simple.txt")==42,"single-c-digit");
["40+2"].save("savedata/uppercase.txt","C0Z");
["40+2"].save("savedata/utf8.txt","utf-8c0");
writerCheck(Scripts.evalStorage("savedata/uppercase.txt")==42 && Scripts.evalStorage("savedata/utf8.txt")==42,"plain-and-web-utf8");
for(var i=0;i<binaryModes.count;i++){
  var path="savedata/binary-"+binaryModes[i]+".bin";
  [7,"雪"].saveStruct(path,binaryModes[i]);
  var loaded=[].loadStruct(path);writerCheck(loaded[0]==7 && loaded[1]=="雪","binary-isolation:"+binaryModes[i]);
}
var dictionary=%["value"=>9007199254740993,"text"=>"雪"];
(Dictionary.saveStruct incontextof dictionary)("savedata/dictionary-b.bin","b");
(Dictionary.saveStruct incontextof dictionary)("savedata/dictionary-bc0.bin","bc0");
var dictionaryRead=Dictionary.loadStruct("savedata/dictionary-bc0.bin");
writerCheck(dictionaryRead.value===9007199254740993 && dictionaryRead.text=="雪","dictionary-binary-isolation");
// This imported mode-0 envelope is a fixed read fixture, never writer output.
writerCheck([].load("legacy-c0.txt")[0]=="40+2" && Scripts.evalStorage("legacy-c0.txt")==42,"legacy-c0-read");
Debug.message("text-writer-modes:encodings-ready");
`

for (const backend of ['asyncify', 'jspi'] as const) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: native text creation rejects modes at the save call and permits legal writes immediately afterward`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        backups: SystemBackup[] = []
      try {
        await page.locator('#files').setInputFiles(files(binary, rejectionProgram))
        await ready(page, 'before-rejections')
        const before = await exportSystemSaves(page)
        backups.push(before)
        expect(before.files.map(({ path }) => path).sort()).toEqual(
          paths(
            binary,
            rejectedKinds.map((kind) => `keep-${kind}.txt`),
          ),
        )
        await evaluate(page, 'runRejectedSaves()', '8:8')
        const after = await exportSystemSaves(page)
        backups.push(after)
        expect(after.files.map(({ path }) => path).sort()).toEqual(
          paths(
            binary,
            rejectedKinds.flatMap((kind) => [
              `keep-${kind}.txt`,
              `after-${kind}-0.txt`,
              `after-${kind}-1.txt`,
            ]),
          ),
        )
        for (const kind of rejectedKinds) {
          const old = `savedata/keep-${kind}.txt`
          expect(saved(before, old)).toEqual(Buffer.from(`original:${kind}\r\n`))
          expect(saved(after, old)).toEqual(saved(before, old))
          for (const existing of [0, 1])
            expect(saved(after, `savedata/after-${kind}-${existing}.txt`)).toEqual(
              Buffer.from(`continued:${kind}:${existing}\r\n`),
            )
        }
        await expect(page.locator('#logs')).toContainText(prefix + 'catch-detail:')
      } finally {
        await info.attach('writer-creation-before-and-after-exports', {
          body: JSON.stringify(backups),
          contentType: 'application/json',
        })
        await info.attach('writer-creation-worker-logs', {
          body: await page.locator('#logs').innerText(),
          contentType: 'text/plain',
        })
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true])
      }
    })

    test(`${variant}: short explicit updates preserve exact suffix bytes across Stop, reload and a fresh Worker`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        input = files(binary, updateProgram),
        backups: SystemBackup[] = []
      try {
        for (const count of [1, 2]) {
          await page.locator('#files').setInputFiles(input)
          await ready(page, `updates:${count}`)
          const backup = await exportSystemSaves(page)
          backups.push(backup)
          expect(backup.files.map(({ path }) => path).sort()).toEqual(
            paths(binary, [
              'update-counter.txt',
              ...updates.map(({ name }) => `update-${name}.txt`),
            ]),
          )
          expect(saved(backup, 'savedata/update-counter.txt')).toEqual(Buffer.from(`${count}\r\n`))
          for (const update of updates) {
            const short = utf16(shortText),
              expected = update.offset === undefined ? short : utf16(seedText)
            if (update.offset !== undefined) short.copy(expected, update.offset)
            const actual = saved(backup, `savedata/update-${update.name}.txt`)
            expect(actual, `${update.mode || '(replace)'} exact exported bytes`).toEqual(expected)
            if (count === 2)
              expect(actual).toEqual(saved(backups[0], `savedata/update-${update.name}.txt`))
          }
          await stopSystemPage(page, setup.errors)
          await expect.poll(() => setup.workers.filter(({ closed }) => closed).length).toBe(count)
          if (count === 1) await page.reload()
        }
        expect(backups[1].gameId).toBe(backups[0].gameId)
        expect(setup.workers).toHaveLength(2)
      } finally {
        await info.attach('writer-offset-reload-exports', {
          body: JSON.stringify({ updates, backups }),
          contentType: 'application/json',
        })
        await info.attach('writer-offset-worker-logs', {
          body: await page.locator('#logs').innerText(),
          contentType: 'text/plain',
        })
        await stopSystemPage(page, setup.errors)
      }
    })

    test(`${variant}: compressed text exports independently inflate while binary modes stay serializer bytes and legacy c0 remains readable`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend)
      let backup: SystemBackup | undefined
      try {
        await page.locator('#files').setInputFiles([
          ...files(binary, encodingProgram),
          {
            name: 'legacy-c0.txt',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from('fefe00fffe353431302a2a33320d000a00', 'hex'),
          },
        ])
        await ready(page, 'encodings-ready')
        backup = await exportSystemSaves(page)
        expect(backup.files.map(({ path }) => path).sort()).toEqual(
          paths(binary, [
            ...compressedModes.map((mode) => `compressed-${mode}.txt`),
            ...binaryModes.map((mode) => `binary-${mode}.bin`),
            'simple.txt',
            'uppercase.txt',
            'utf8.txt',
            'dictionary-b.bin',
            'dictionary-bc0.bin',
          ]),
        )
        for (const mode of compressedModes) {
          const bytes = saved(backup, `savedata/compressed-${mode}.txt`)
          expect([...bytes.subarray(0, 5)]).toEqual([254, 254, 2, 255, 254])
          expect(bytes.readBigUInt64LE(5)).toBe(BigInt(bytes.length - 21))
          expect(bytes.readBigUInt64LE(13)).toBe(12n)
          // The output of the real browser CompressionStream is decoded by
          // Node zlib, independently from the engine's text/codec implementation.
          expect(inflateSync(bytes.subarray(21), { maxOutputLength: 1024 })).toEqual(
            Buffer.from('40+2\r\n', 'utf16le'),
          )
        }
        expect([...saved(backup, 'savedata/simple.txt').subarray(0, 5)]).toEqual([
          254, 254, 1, 255, 254,
        ])
        expect(saved(backup, 'savedata/uppercase.txt')).toEqual(utf16('40+2\r\n'))
        expect(saved(backup, 'savedata/utf8.txt')).toEqual(Buffer.from('40+2\r\n'))
        const arrayBinary = saved(backup, 'savedata/binary-b.bin')
        expect(arrayBinary.subarray(0, 8).toString('ascii')).toBe('KBAD100\0')
        for (const mode of binaryModes)
          expect(saved(backup, `savedata/binary-${mode}.bin`)).toEqual(arrayBinary)
        const dictionaryBinary = saved(backup, 'savedata/dictionary-b.bin')
        expect(dictionaryBinary.subarray(0, 8).toString('ascii')).toBe('KBAD100\0')
        expect(saved(backup, 'savedata/dictionary-bc0.bin')).toEqual(dictionaryBinary)
      } finally {
        await info.attach('writer-encoding-exports', {
          body: JSON.stringify({ backup }),
          contentType: 'application/json',
        })
        await info.attach('writer-encoding-worker-logs', {
          body: await page.locator('#logs').innerText(),
          contentType: 'text/plain',
        })
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true])
      }
    })
  }

  for (const capability of [undefined, 1])
    test(`${backend}: the production loader rejects ${capability === undefined ? 'missing' : 'obsolete'} text-stream capability and recovers with the exact original manifest`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        manifestBytes = await readFile(resolve('.generated/wasm/manifest.json')),
        manifestHash = createHash('sha256').update(manifestBytes).digest('hex'),
        manifestPath = `/wasm/manifest-${manifestHash.slice(0, 16)}.json`,
        matches = (url: URL) => url.pathname === manifestPath,
        intercepted: { original: WasmManifest; served: WasmManifest }[] = [],
        routeErrors: string[] = []
      await page.context().route(matches, async (route) => {
        try {
          const response = await route.fetch(),
            bytes = await response.body()
          if (!response.ok() || !bytes.equals(manifestBytes))
            throw new Error('Text-stream loader intervention requires the exact hosted manifest')
          const original = JSON.parse(bytes.toString('utf8')) as WasmManifest,
            served = structuredClone(original)
          if (served.capabilities?.nativeTextStreams !== 2)
            throw new Error('The hosted build must provide nativeTextStreams=2')
          if (capability === undefined) delete served.capabilities.nativeTextStreams
          else served.capabilities.nativeTextStreams = capability
          intercepted.push({ original, served })
          await route.fulfill({ response, json: served })
        } catch (error) {
          routeErrors.push(String(error))
          await route.abort('failed')
        }
      })
      try {
        await page
          .locator('#files')
          .setInputFiles(files(false, 'Debug.message("text-writer-modes:must-not-start");'))
        await expect(page.locator('#logs')).toContainText(
          'WASM manifest is missing native text stream support',
        )
        await expect(page.locator('#status')).toHaveText('运行失败')
        await expect(page.locator('#choose-files')).toBeEnabled()
        await expect(page.locator('#evaluate')).toBeDisabled()
        await expect(page.locator('#stop')).toBeDisabled()
        await expect(page.getByText(prefix + 'must-not-start', { exact: true })).toHaveCount(0)
        await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true])
        expect(routeErrors).toEqual([])
        expect(intercepted).toHaveLength(1)
        expect({
          ...intercepted[0].served,
          capabilities: { ...intercepted[0].served.capabilities, nativeTextStreams: 2 },
        }).toEqual(intercepted[0].original)
        await info.attach('text-stream-rejected-loader-logs', {
          body: await page.locator('#logs').innerText(),
          contentType: 'text/plain',
        })
        await page.context().unroute(matches)
        await page.locator('#clear-log').click()
        await page.locator('#files').setInputFiles(
          files(
            false,
            String.raw`
  var rejected=false;try{["bad"].save("savedata/rejected.txt","c0");}catch(e){rejected=true;}
  writerCheck(rejected,"recovered-mode-preflight");
  ["recovered"].save("savedata/recovered.txt","utf-8");
  writerCheck([].load("savedata/recovered.txt","utf-8")[0]=="recovered","recovered-text-save");
  writerCheck(!Storages.isExistentStorage("savedata/rejected.txt"),"recovered-no-invalid-file");
  Debug.message("text-writer-modes:loader-recovered");
  `,
          ),
        )
        await ready(page, 'loader-recovered')
        const backup = await exportSystemSaves(page)
        expect(backup.files.map(({ path }) => path)).toEqual(['savedata/recovered.txt'])
        expect(saved(backup, 'savedata/recovered.txt')).toEqual(Buffer.from('recovered\r\n'))
        expect(setup.workers).toHaveLength(2)
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true, true])
      } finally {
        await page.context().unroute(matches)
        await info.attach('text-stream-manifest-intervention', {
          body: JSON.stringify({ manifestPath, manifestHash, intercepted, routeErrors }),
          contentType: 'application/json',
        })
        if (await page.locator('#stop').isEnabled()) await stopSystemPage(page, setup.errors)
      }
    })
}

// Original KAG's nonzero BMP thumbnail offset remains covered by the existing
// tests/probes/kag-browser.ts save/load/thumbnail/reload compatibility flow.
// These fixtures exercise text stream bytes; they do not claim to recreate KAG.
