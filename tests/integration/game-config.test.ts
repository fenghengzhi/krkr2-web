import assert from 'node:assert/strict'
import test from 'node:test'
import { createHeadlessRuntime, headless } from '../helpers/headless.ts'
import { createHeadlessImageJpegProvider } from '../helpers/image-jpeg.ts'
import { jpegContractFiles } from '../helpers/jpeg-contract.ts'
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
