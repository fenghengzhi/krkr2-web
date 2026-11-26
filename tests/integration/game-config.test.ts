import assert from 'node:assert/strict'
import test from 'node:test'
import { createHeadlessRuntime, headless } from '../helpers/headless.ts'
import { createHeadlessImageJpegProvider } from '../helpers/image-jpeg.ts'
import { jpegContractFiles } from '../helpers/jpeg-contract.ts'
import { embedXp3, xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'

const project = { directory: 'Story/Data/', executableDirectory: 'Story/' }
const program = `
var cfgWin=new Window(),cfgImage=new Layer(cfgWin,null);
cfgImage.loadImages("gray64.jpg");
var launch=[System.exeName,System.dataPath,System.getArgument("-datapath"),
 System.getArgument("-edition"),System.getArgument("-jpegdec"),cfgImage.getMainPixel(0,0)].join("|");
[launch].save(System.dataPath+"route.txt","utf-8");
`
for (const binary of [false, true]) for (const hostOverride of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: project configuration selects the actual VM, JPEG and save settings (host override ${hostOverride})`, async () => {
    const saves = new MemorySaveStore(), profile = hostOverride ? 'Host' : 'Profiles'
    await saves.commit([{ path: 'Story/' + profile + '/novel.CFU', bytes: new TextEncoder().encode(
      'edition=user\r\ndatapath=$(exepath)/Ignore\r\njpegdec=high\r\ndebug=yes\r\n') }])
    const jpeg = createHeadlessImageJpegProvider(), precisions: string[] = [], debug: boolean[] = []
    const { session } = await headless({
      'Story/Novel.EXE': new Uint8Array([77, 90]), 'Story/novel.Cf': 'edition=default\r\ndatapath=$(exepath)/Profiles\r\njpegdec=normal',
      ['Story/' + profile + '/Novel.cfu']: 'edition=shipped\r\njpegdec=normal',
      'Story/Data/Novel.cf': 'edition=wrong\r\ndatapath=Wrong',
      'Story/Data/gray64.jpg': jpegContractFiles()['gray64.jpg']!,
      'Story/Data/route.tjs': program, 'Story/Data/startup.tjs': binary
        ? 'Scripts.compileStorage("route.tjs",System.dataPath+"route.cjs",false,true,false);Scripts.execStorage(System.dataPath+"route.cjs");'
        : 'Scripts.execStorage("route.tjs");',
    }, { project, saveStore: saves,
      arguments: hostOverride ? new Map([['-datapath', '$(exepath)/Host'], ['-jpegdec', 'low'], ['-debug', 'no']]) : undefined,
      createRuntime(handler, control, options) {
        debug.push(options.debugMode)
        return createHeadlessRuntime(handler, control, options)
      },
      imageJpeg: { async open(source, mode, precision) {
        precisions.push(precision)
        return jpeg.open(source, mode, precision)
      }, dispose: () => jpeg.dispose() },
    })
    const failures: unknown[] = []
    try {
      await session.start()
      const precision = hostOverride ? 'low' : 'high'
      const expected = ['game://./Story/Novel.EXE', 'game://./Story/' + profile + '/',
        '$(exepath)/' + (hostOverride ? 'Host' : 'Ignore'), 'user', precision, 0x404040].join('|')
      assert.equal(await session.evaluate('launch'), expected)
      assert.deepEqual(debug, [!hostOverride])
      assert.deepEqual(precisions, [precision])
      const slot = session.exportSaves().find((file) => file.path === 'Story/' + profile + '/route.txt')
      assert(slot)
      assert.equal(new TextDecoder().decode(slot.bytes).trimEnd(), expected)
    } catch (error) { failures.push(error) }
    try { await session.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Game configuration or cleanup failed', { cause: failures[0] })
  })
}

for (const binary of [false, true]) {
  test(`${binary ? 'bytecode' : 'source'}: a combined launcher reads its embedded defaults and runs the game packed in the same file`, async (t) => {
    const chapter = `
var chapterWindow=new Window();chapterWindow.caption="Bonus chapter";chapterWindow.visible=true;
var chapter=[System.getArgument("-route"),System.getArgument("-edition"),System.exeName,
 Storages.getPlacedPath("chapter.tjs"),System.dataPath].join("|");
[chapter].save(System.dataPath+"chapter.txt","utf-8");`
    const archive = xp3Fixture({
      'startup.tjs': binary
        ? 'Scripts.compileStorage("chapter.tjs",System.dataPath+"chapter.cjs",false,true,false);Scripts.execStorage(System.dataPath+"chapter.cjs");'
        : 'Scripts.execStorage("chapter.tjs");',
      'chapter.tjs': chapter, 'Story.cf': 'route=wrong-archive-file',
    }, { compressed: true })
    const image = embedXp3(archive.bytes, 768 * 1024), at = 512 * 1024 + 16
    image.write('XOPT_EMBED_AREA_', at, 'ascii'); image.writeUInt32LE(256, at + 16)
    image.write('datapath=$(exepath)/Profiles\r\nroute=starter\r\nedition=complete\r\n', at + 20, 'ascii')
    const { session } = await headless({
      'Release/Story.exe': image, 'Release/Profiles/Story.cfu': 'route=bonus\r\ndatapath=Other',
    }, { project: { directory: 'Release/Story.exe>', executableDirectory: 'Release/' } })
    t.after(() => session.stop())
    await session.start()
    const expected = 'bonus|complete|game://./Release/Story.exe|game://./Release/Story.exe>chapter.tjs|game://./Release/Profiles/'
    assert.equal(await session.evaluate('chapter'), expected)
    assert.equal(new TextDecoder().decode(session.exportSaves().find((file) => file.path === 'Release/Profiles/chapter.txt')!.bytes).trimEnd(), expected)
  })
}
