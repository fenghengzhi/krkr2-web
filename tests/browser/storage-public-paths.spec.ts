import { magnifyPixelWindow } from '../helpers/pixel-window.ts'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { imageFixture } from '../helpers/image-fixtures.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'
import { wave } from '../helpers/audio.ts'
import {
  exportSystemSaves,
  prepareSystemPage,
  stopSystemPage,
  type SystemBackup,
} from '../helpers/web-system-core.ts'
import {
  buildStorageEmbedding,
  openStorageEmbedding,
  runStorageEmbedding,
} from '../helpers/web-storage-paths.ts'

const prefix = 'storage-public-paths:'
const textFile = (name: string, source: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(source),
})
const demand = String.raw`
function pathCheck(value,message){if(!value)throw new Exception("storage-public-paths:"+message);}
`
function files(binary: boolean, source: string) {
  return [
    textFile(
      'startup.tjs',
      binary
        ? 'Scripts.compileStorage(Storages.getFullPath("PublicPaths.tjs"),Storages.getFullPath("savedata/PublicPaths.cjs"),false,true,false);Scripts.execStorage(Storages.getFullPath("savedata/PublicPaths.cjs"));'
        : 'Scripts.execStorage(Storages.getFullPath("PublicPaths.tjs"));',
    ),
    textFile('PublicPaths.tjs', demand + source),
  ]
}
const mark = (page: Page, text: string) => page.getByText(prefix + text, { exact: true })
async function ready(page: Page, text: string) {
  await expect(mark(page, text)).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
}
async function centerPixel(page: Page) {
  const png = await page.locator('canvas').screenshot()
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(
        await (await fetch('data:image/png;base64,' + base64)).blob(),
      ),
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      context = canvas.getContext('2d')!
    try {
      context.drawImage(bitmap, 0, 0)
      return Array.from(
        context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1)
          .data,
      )
    } finally {
      bitmap.close()
    }
  }, png.toString('base64'))
}

const searchProgram = String.raw`
var upper=Storages.getFullPath("./Case.tjs"),lower=Storages.getFullPath("case.tjs");
pathCheck(upper=="game://./Case.tjs" && lower=="game://./case.tjs","path-case");
pathCheck(Scripts.evalStorage(upper)==11 && Scripts.evalStorage(lower)==22,"case-exact-read");
pathCheck(Scripts.evalStorage("Case.tjs")==11,"relative-read");
pathCheck(Storages.getFullPath(upper)===upper,"idempotent");
pathCheck(Storages.getFullPath("")=="" && Storages.getFullPath("game://./")=="game://./","empty-vs-root");
pathCheck(Storages.getFullPath("First\\..\\Second\\")=="game://./Second/","directory-tail");
pathCheck(Storages.getFullPath("bundle.data>")=="game://./bundle.data>","archive-root");
var future=Storages.getFullPath("missing/Future.dat");
pathCheck(future=="game://./missing/Future.dat" && Storages.getPlacedPath(future)=="" && !Storages.isExistentStorage(future),"future-name");
["future"].save(future,"utf-8");
pathCheck(Storages.getFullPath("missing/Future.dat")===future && [].load(future,"utf-8")[0]=="future","future-write");
var badNames=["../escape.tjs","First/../../escape.tjs","bundle.data>../escape.tjs","bundle.data>inner.xp3>entry.tjs","C:\\escape.tjs","\\\\server\\share","https://host.invalid/file.tjs","First/../https://host.invalid/file.tjs","./C:\\escape.tjs"],rejected=0;
for(var i=0;i<badNames.count;i++){try{var bad=Storages.getFullPath(badNames[i]);}catch(e){rejected++;}}
pathCheck(rejected==badNames.count,"invalid-addresses");
pathCheck(Storages.getFullPath("%2e%2e/%2f#part.tjs")=="game://./%2e%2e/%2f#part.tjs","literal-url-characters");
var ambiguous=false;try{var found=Storages.getPlacedPath("CASE.TJS");}catch(e){ambiguous=true;}
pathCheck(ambiguous,"folded-ambiguity");
Storages.addAutoPath("First/");Storages.addAutoPath("game://./Second/");
function selected(name,path,value){var selectedPath=Storages.getPlacedPath(name);pathCheck(selectedPath==path,"placed:"+name);pathCheck(Scripts.evalStorage(selectedPath)==value,"placed-read:"+name);}
selected("no-such-dir/value.tjs","game://./Second/value.tjs",202);
selected("hit.tjs","game://./hit.tjs",7);
Storages.addAutoPath("game://./First/");
selected("value.tjs","game://./Second/value.tjs",202);
var badAuto=false;try{Storages.addAutoPath("First");}catch(e){badAuto=true;}
pathCheck(badAuto,"autopath-input-tail");
selected("value.tjs","game://./Second/value.tjs",202);
Storages.removeAutoPath("absent/");Storages.addAutoPath("nonexistent/");
pathCheck(Storages.getPlacedPath("deep-only.tjs")=="","no-recursive-autopath");
Storages.removeAutoPath("Second\\");
selected("value.tjs","game://./First/value.tjs",101);
Storages.removeAutoPath("game://./First/");
Storages.addAutoPath("game://./bundle.data>シーン/");
selected("lost/value.tjs","game://./bundle.data>シーン/value.tjs",42);
Storages.removeAutoPath("bundle.data>シーン/");
Storages.addAutoPath("game://./bundle.data>");
pathCheck(Storages.getPlacedPath("lost/empty.bin")=="game://./bundle.data>empty.bin","archive-root-search");
Storages.removeAutoPath("bundle.data>");
Storages.addAutoPath("game://./");Storages.removeAutoPath("game://./");
var archived=Storages.getFullPath("bundle.data>シーン/value.tjs"),alias=Storages.getFullPath("シーン/value.tjs");
pathCheck(Scripts.evalStorage(archived)==42 && Scripts.evalStorage(alias)==42,"initial-archive-alias");
["84"].save(alias,"utf-8");
pathCheck(Scripts.evalStorage(alias)==84 && Scripts.evalStorage("シーン/value.tjs")==84 && Scripts.evalStorage(archived)==42,"overlay-does-not-write-archive");
var win=new Window();win.visible=true;win.setInnerSize(1,1);
var root=new Layer(win,null);root.loadImages(Storages.getFullPath("bundle.data>art/pixel.bmp"));root.setSize(1,1);
pathCheck(root.getMainPixel(0,0)==0x336699,"archive-image-read");
var blocked=0,payload=%["value"=>9];
try{["99"].save(archived,"utf-8");}catch(e){blocked++;}
try{(Dictionary.saveStruct incontextof payload)(archived,"b");}catch(e){blocked++;}
try{root.saveLayerImage(Storages.getFullPath("bundle.data>saved.bmp"));}catch(e){blocked++;}
pathCheck(blocked==3 && Scripts.evalStorage(archived)==42 && Scripts.evalStorage(alias)==84,"archive-writes-rejected");
Debug.message("storage-public-paths:search-ready");
`

const persistenceProgram = String.raw`
var oldCounter=System.dataPath+"PathCounter.txt",counterPath=Storages.getFullPath(oldCounter),count=0;
if(Storages.isExistentStorage(counterPath)){
  count=int([].load(oldCounter,"utf-8")[0]);
  pathCheck([].load(Storages.getFullPath("savedata/Lines.txt"),"utf-8")[0]=="保存の文字 雪 😀","text-recovered");
  var recovered=Dictionary.loadStruct(Storages.getFullPath("savedata/State.bin"));
  pathCheck(recovered.large===9007199254740993 && recovered.count==count,"binary-recovered");
  pathCheck(Scripts.evalStorage(Storages.getFullPath("savedata/State.txt")).count==count,"dictionary-text-recovered");
  var array=[].loadStruct(Storages.getFullPath("savedata/Items.bin"));
  pathCheck(array[0]==count && array[1]=="items","array-binary-recovered");
  pathCheck(Scripts.evalStorage(Storages.getFullPath("savedata/Items.txt"))[0]==count,"array-text-recovered");
  pathCheck(Scripts.evalStorage(Storages.getFullPath("savedata/Expression.cjs"))==42,"bytecode-recovered");
}
count++;
[string(count)].save(counterPath,"utf-8");
["保存の文字 雪 😀"].save(Storages.getFullPath("savedata/Lines.txt"),"utf-8");
var state=%["large"=>9007199254740993,"count"=>count];
(Dictionary.saveStruct incontextof state)(Storages.getFullPath("savedata/State.bin"),"b");
(Dictionary.saveStruct incontextof state)(Storages.getFullPath("savedata/State.txt"));
[count,"items"].saveStruct(Storages.getFullPath("savedata/Items.bin"),"b");
[count,"items"].saveStruct(Storages.getFullPath("savedata/Items.txt"));
Scripts.compileStorage(Storages.getFullPath("Expression.tjs"),Storages.getFullPath("savedata/Expression.cjs"),true,true,true);
pathCheck(Scripts.evalStorage("savedata/Expression.cjs")==42 && Scripts.evalStorage(Storages.getPlacedPath("savedata/Expression.cjs"))==42,"compiled-target-closure");
pathCheck([].load(oldCounter,"utf-8")[0]==string(count) && [].load(counterPath,"utf-8")[0]==string(count),"read-after-write");
pathCheck(Storages.getPlacedPath(oldCounter)==counterPath,"saved-placed-path");
Debug.logLocation=Storages.getFullPath("Diagnostics/");Debug.startLogToFile();
Debug.message("storage-public-paths:persist:"+count);
`

const mediaProgram = String.raw`
var win=new Window();win.visible=true;win.setInnerSize(64,48);
var root=new Layer(win,null);root.setSize(64,48);root.fillRect(0,0,64,48,0xff000000);
var hero=new Layer(win,root),copy=new Layer(win,root);
var tags=hero.loadImages(Storages.getFullPath("Art/Hero"));
pathCheck(tags.offs_x=="12" && hero.getMainPixel(0,0)==0xc86432 && hero.getMaskPixel(1,0)==128 && hero.getProvincePixel(1,0)==1,"image-and-companions");
hero.saveLayerImage(Storages.getFullPath("savedata/CanonicalImage.bmp"),"bmp32");
copy.loadImages(Storages.getFullPath("savedata/CanonicalImage.bmp"));
pathCheck(copy.getMainPixel(0,0)==0xc86432 && copy.getMaskPixel(1,0)==128,"saved-image-read");
hero.loadProvinceImage(Storages.getFullPath("Art/Replacement"));
pathCheck(hero.getProvincePixel(1,0)==128,"explicit-province-read");
var textLayer=new Layer(win,root);textLayer.setImageSize(40,24);textLayer.type=ltAlpha;textLayer.font.height=20;
textLayer.font.face=Storages.getFullPath("Fonts/narrow.ttf");textLayer.font.faceIsFileName=true;
pathCheck(textLayer.font.getTextWidth("AV")==24,"canonical-font-face");
textLayer.font.mapPrerenderedFont(Storages.getFullPath("Fonts/coverage-v1.tft"));
pathCheck(textLayer.font.getTextWidth("AB")==11,"canonical-prerendered-font");
textLayer.drawText(0,0,"AB",0x123456);
pathCheck(textLayer.getMainPixel(1,15)==0x123456 && textLayer.getMaskPixel(1,14)==64,"font-raster-read");
class PathSound extends WaveSoundBuffer {
 function PathSound(){super.WaveSoundBuffer(null);}
 function onLabel(name){Debug.message("storage-public-paths:audio-label:"+name);}
}
var sound=new PathSound();sound.open(Storages.getFullPath("Audio/tone.wav"));sound.looping=true;
pathCheck(sound.frequency==44100,"canonical-wave-open");
var frameLayer=new Layer(win,root);frameLayer.visible=true;
var movie=new VideoOverlay(win);movie.mode=vomLayer;movie.layer1=frameLayer;
movie.open(Storages.getFullPath("Video/colors.mp4"));movie.prepare();
pathCheck(movie.originalWidth==64 && movie.originalHeight==48 && movie.numberOfFrame==18,"canonical-video-open");
Debug.message("storage-public-paths:media-ready");
`

for (const backend of ['asyncify', 'jspi'] as const) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: public paths preserve case and real placement through autopath, archive reads and plane-alias writes`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend)
      try {
        await page.locator('#files').setInputFiles([
          { name: 'bundle.data', mimeType: 'application/octet-stream', buffer: zipFixture() },
          ...files(binary, searchProgram),
          ...Object.entries({
            'Case.tjs': '11',
            'case.tjs': '22',
            'hit.tjs': '7',
            'First/value.tjs': '101',
            'Second/value.tjs': '202',
            'First/hit.tjs': '17',
            'Second/hit.tjs': '27',
            'Second/deeper/deep-only.tjs': '99',
          }).map(([name, value]) => textFile(name, value)),
        ])
        await ready(page, 'search-ready')
        await expect(page.locator('canvas')).toHaveJSProperty('width', 1)
        await expect(page.locator('canvas')).toHaveJSProperty('height', 1)
        await magnifyPixelWindow(page.locator('canvas'))
        expect(await centerPixel(page)).toEqual([51, 102, 153, 255])
        const backup = await exportSystemSaves(page)
        expect(backup.files.map(({ path }) => path).sort()).toEqual([
          'missing/Future.dat',
          ...(binary ? ['savedata/PublicPaths.cjs'] : []),
          'シーン/value.tjs',
        ])
        expect(
          Buffer.from(
            backup.files.find(({ path }) => path === 'シーン/value.tjs')!.base64,
            'base64',
          )
            .toString('utf8')
            .replace(/^\uFEFF/, '')
            .trim(),
        ).toBe('84')
        await info.attach('canonical-search-and-overlay-backup', {
          body: JSON.stringify(backup),
          contentType: 'application/json',
        })
      } finally {
        await info.attach('canonical-search-worker-logs', {
          body: await page.locator('#logs').innerText(),
          contentType: 'text/plain',
        })
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      }
    })

    test(`${variant}: canonical native streams persist relative save keys through Stop, reload and a fresh Worker`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        input = [...files(binary, persistenceProgram), textFile('Expression.tjs', '6*7')],
        backups: SystemBackup[] = []
      try {
        for (const count of [1, 2]) {
          await page.locator('#files').setInputFiles(input)
          await ready(page, `persist:${count}`)
          await evaluate(page, 'count', String(count))
          const backup = await exportSystemSaves(page)
          backups.push(backup)
          expect(backup.files.map(({ path }) => path).sort()).toEqual([
            'Diagnostics/krkr.console.log',
            'savedata/Expression.cjs',
            'savedata/Items.bin',
            'savedata/Items.txt',
            'savedata/Lines.txt',
            'savedata/PathCounter.txt',
            ...(binary ? ['savedata/PublicPaths.cjs'] : []),
            'savedata/State.bin',
            'savedata/State.txt',
          ])
          const saved = (path: string) =>
            Buffer.from(backup.files.find((file) => file.path === path)!.base64, 'base64')
          expect(
            saved('savedata/PathCounter.txt')
              .toString('utf8')
              .replace(/^\uFEFF/, '')
              .trim(),
          ).toBe(String(count))
          expect(saved('savedata/Items.bin').subarray(0, 8).toString('ascii')).toBe('KBAD100\0')
          expect(saved('savedata/State.bin').subarray(0, 8).toString('ascii')).toBe('KBAD100\0')
          expect(saved('savedata/Expression.cjs').subarray(0, 4).toString('ascii')).toBe('TJS2')
          expect([...saved('Diagnostics/krkr.console.log').subarray(0, 2)]).toEqual([255, 254])
          expect(saved('Diagnostics/krkr.console.log').toString('utf16le')).toContain(
            `storage-public-paths:persist:${count}\r\n`,
          )
          await stopSystemPage(page, setup.errors)
          await expect.poll(() => setup.workers.filter(({ closed }) => closed).length).toBe(count)
          if (count === 1) await page.reload()
        }
        expect(backups[1].gameId).toBe(backups[0].gameId)
        expect(setup.workers).toHaveLength(2)
        const firstLog = Buffer.from(
            backups[0].files.find(({ path }) => path === 'Diagnostics/krkr.console.log')!.base64,
            'base64',
          ),
          nextLog = Buffer.from(
            backups[1].files.find(({ path }) => path === 'Diagnostics/krkr.console.log')!.base64,
            'base64',
          )
        expect(nextLog.subarray(0, firstLog.length)).toEqual(firstLog)
      } finally {
        await info.attach('canonical-stream-persistence-backups', {
          body: JSON.stringify(backups),
          contentType: 'application/json',
        })
        await info.attach('canonical-stream-worker-logs', {
          body: await page.locator('#logs').innerText(),
          contentType: 'text/plain',
        })
        await stopSystemPage(page, setup.errors)
      }
    })

    test(`${variant}: canonical resources reach image companions, image saves, file fonts, audio labels and video frames`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend)
      try {
        await page.locator('#files').setInputFiles([
          ...files(binary, mediaProgram),
          ...[
            ['Art/Hero.png', 'main.png'],
            ['Art/Hero_m.png', 'mask.png'],
            ['Art/Hero_p.png', 'palette-2x1.png'],
            ['Art/Replacement.png', 'mask.png'],
          ].map(([name, fixture]) => ({
            name,
            mimeType: 'image/png',
            buffer: imageFixture(fixture),
          })),
          ...(await Promise.all(
            ['narrow.ttf', 'coverage-v1.tft'].map(async (name) => ({
              name: `Fonts/${name}`,
              mimeType: 'application/octet-stream',
              buffer: await readFile(new URL(`../fixtures/font/${name}`, import.meta.url)),
            })),
          )),
          {
            name: 'Audio/tone.wav',
            mimeType: 'audio/wav',
            buffer: Buffer.from(
              wave(
                Array.from(
                  { length: 4410 },
                  (_, i) => Math.sin((i * 2 * Math.PI * 440) / 44100) * 0.3,
                ),
                44100,
              ),
            ),
          },
          textFile('Audio/tone.wav.sli', '#2.00\nLabel {Position=882;Name="canonical-cue";}'),
          {
            name: 'Video/colors.mp4',
            mimeType: 'video/mp4',
            buffer: await readFile(new URL('../fixtures/video/colors.mp4', import.meta.url)),
          },
        ])
        await ready(page, 'media-ready')
        await expect(page.locator('canvas')).toHaveJSProperty('width', 64)
        await expect(page.locator('canvas')).toHaveJSProperty('height', 48)
        const red = await centerPixel(page)
        expect(red[0]).toBeGreaterThan(220)
        expect(red[1]).toBeLessThan(30)
        await evaluate(page, '(function(){movie.frame=12;return movie.frame;})()', '12')
        const blue = await centerPixel(page)
        expect(blue[2]).toBeGreaterThan(220)
        expect(blue[0]).toBeLessThan(30)
        await evaluate(page, '(function(){sound.play();return sound.frequency;})()', '44100')
        if ((await page.locator('#sound-toggle').textContent()) === '开启声音')
          await page.locator('#sound-toggle').click()
        await expect(page.locator('#logs')).toContainText(prefix + 'audio-label:canonical-cue')
        await expect
          .poll(() =>
            page
              .locator('#sound-level')
              .evaluate((node) => Number((node as HTMLElement).dataset.maxPeak)),
          )
          .toBeGreaterThan(0.1)
        await evaluate(
          page,
          '(function(){sound.stop();return Storages.getPlacedPath("savedata/CanonicalImage.bmp");})()',
          'game://./savedata/CanonicalImage.bmp',
        )
        const backup = await exportSystemSaves(page)
        expect(backup.files.map(({ path }) => path).sort()).toEqual([
          'savedata/CanonicalImage.bmp',
          ...(binary ? ['savedata/PublicPaths.cjs'] : []),
        ])
        expect(
          Buffer.from(
            backup.files.find(({ path }) => path === 'savedata/CanonicalImage.bmp')!.base64,
            'base64',
          )
            .subarray(0, 2)
            .toString('ascii'),
        ).toBe('BM')
        await info.attach('canonical-media-output', {
          body: JSON.stringify({ red, blue, backup }),
          contentType: 'application/json',
        })
      } finally {
        await info.attach('canonical-media-worker-logs', {
          body: await page.locator('#logs').innerText(),
          contentType: 'text/plain',
        })
        await stopSystemPage(page, setup.errors)
        await expect(page.locator('video')).toHaveCount(0)
        await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      }
    })
  }

  test(`${backend}: the production loader rejects missing native Storages support and then starts a fresh native class`, async ({
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
          throw new Error('Storage loader intervention requires the exact hosted manifest')
        const original = JSON.parse(bytes.toString('utf8')) as WasmManifest,
          served = structuredClone(original)
        if (served.capabilities?.nativeStorages !== 2)
          throw new Error('The hosted build must provide nativeStorages=2')
        delete served.capabilities.nativeStorages
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
        .setInputFiles(files(false, 'Debug.message("storage-public-paths:must-not-start");'))
      await expect(page.locator('#logs')).toContainText(
        'WASM manifest is missing native Storages support',
      )
      await expect(page.locator('#status')).toHaveText('运行失败')
      await expect(page.locator('#choose-files')).toBeEnabled()
      await expect(page.locator('#evaluate')).toBeDisabled()
      await expect(page.locator('#stop')).toBeDisabled()
      await expect(mark(page, 'must-not-start')).toHaveCount(0)
      await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true])
      expect(routeErrors).toEqual([])
      expect(intercepted).toHaveLength(1)
      expect({
        ...intercepted[0].served,
        capabilities: { ...intercepted[0].served.capabilities, nativeStorages: 2 },
      }).toEqual(intercepted[0].original)
      await info.attach('native-storages-rejected-loader-logs', {
        body: await page.locator('#logs').innerText(),
        contentType: 'text/plain',
      })
      await page.context().unroute(matches)
      await page.locator('#clear-log').click()
      await page.locator('#files').setInputFiles(
        files(
          false,
          String.raw`
pathCheck(Storages instanceof "Class" && !(Storages instanceof "Dictionary"),"recovered-native-class");
pathCheck(Storages.getFullPath("Recovered.tjs")=="game://./Recovered.tjs","recovered-full-name");
Debug.message("storage-public-paths:loader-recovered");
`,
        ),
      )
      await ready(page, 'loader-recovered')
      expect(setup.workers).toHaveLength(2)
      await stopSystemPage(page, setup.errors)
      await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true, true])
    } finally {
      await page.context().unroute(matches)
      await info.attach('native-storages-manifest-intervention', {
        body: JSON.stringify({ manifestPath, manifestHash, intercepted, routeErrors }),
        contentType: 'application/json',
      })
      if (await page.locator('#stop').isEnabled()) await stopSystemPage(page, setup.errors)
    }
  })
}

test.describe('canonical storage paths in the public Player embedding API', () => {
  let build: Awaited<ReturnType<typeof buildStorageEmbedding>>
  test.beforeAll(async () => {
    build = await buildStorageEmbedding()
  })
  for (const backend of ['asyncify', 'jspi'] as const)
    for (const [label, dataPath, logicalPrefix] of [
      ['default', undefined, 'savedata/'],
      ['custom', '$(exepath)/state/../savedata2', 'savedata2/'],
      ['root', '.', ''],
    ] as const)
      test(`${backend}/${label}: public dataPath saves canonical names under relative IndexedDB keys across Worker restart`, async ({
        page,
      }, info) => {
        const setup = await prepareSystemPage(page, backend),
          results: Awaited<ReturnType<typeof runStorageEmbedding>>[] = []
        await openStorageEmbedding(page, build)
        try {
          for (const count of [1, 2]) {
            const result = await runStorageEmbedding(page, build.entry, backend, dataPath)
            results.push(result)
            expect(result.actual).toBe(
              `${logicalPrefix}|game://./${logicalPrefix}CanonicalCounter.txt|${count}`,
            )
            expect(result.errors).toEqual([])
            expect(result.disposed).toBe(true)
            expect(
              result.files.some(
                ({ path, bytes }) =>
                  path === logicalPrefix + 'CanonicalCounter.txt' &&
                  Buffer.from(bytes)
                    .toString('utf8')
                    .replace(/^\uFEFF/, '')
                    .trim() === String(count),
              ),
            ).toBe(true)
            expect(result.files.every(({ path }) => !path.includes('://'))).toBe(true)
            await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
            if (count === 1) await page.reload()
          }
          expect(new Set(results.map(({ gameId }) => gameId)).size).toBe(1)
          expect(
            results
              .at(-1)!
              .files.map(({ path }) => path)
              .sort(),
          ).toEqual([logicalPrefix + 'CanonicalCounter.txt'])
          expect(setup.workers).toHaveLength(2)
          expect(setup.errors).toEqual([])
        } finally {
          await info.attach('canonical-public-player-embedding', {
            body: JSON.stringify({
              build: build.provenance,
              results,
              workers: setup.workers.map(({ url, closed }) => ({ url, closed })),
            }),
            contentType: 'application/json',
          })
        }
      })
})
