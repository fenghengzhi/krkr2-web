import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { writeNativeSaves } from '../../src/player/native-saves.ts'
import { kagControlSource, kagFiles } from '../helpers/kag-scenarios.ts'
import assert from 'node:assert/strict'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'
import { headless } from '../helpers/headless.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: original save files follow the configured System.dataPath across two game directories`, async () => {
  const store = new MemorySaveStore()
  const open = (root: string) => headless({
    [root + 'content-data/startup.tjs']: binary
      ? 'Scripts.compileStorage("reader.tjs",System.exePath+"reader.cjs",false,true,false);Scripts.execStorage(System.exePath+"reader.cjs");'
      : 'Scripts.execStorage("reader.tjs");',
    [root + 'content-data/reader.tjs']: 'System.exitOnNoWindowStartup=false;function loadSlot(){return Scripts.evalStorage(System.dataPath+"章/Slot.ksd");}',
  }, { project: { directory: root + 'content-data/', executableDirectory: root },
    arguments: new Map([['-datapath', '$(exepath)/User Saves']]), saveStore: store })
  const first = (await open('Edition A/')).session
  const original = new TextEncoder().encode('"chapter 7"')
  let exported: SaveFile[]
  try {
    await first.importSaves([{ path: '章/Slot.ksd', bytes: original }], 'data-directory')
    await first.start()
    assert.equal(await first.evaluate('loadSlot()'), 'chapter 7')
    await first.evaluate('["keep"].save(System.exePath+"outside.txt")')
    exported = first.exportSaves('data-directory')
    assert.deepEqual(exported, [{ path: '章/Slot.ksd', bytes: original }])
    await assert.rejects(first.importSaves(exported, 'data-directory'), /Pause/)
  } finally { await first.stop() }
  const second = (await open('Edition B/')).session
  try {
    assert.deepEqual(second.exportSaves('data-directory'), [])
    await second.importSaves(exported, 'data-directory')
    await second.start(); assert.equal(await second.evaluate('loadSlot()'), 'chapter 7')
    assert(second.exportSaves().some((entry) => entry.path === 'Edition A/outside.txt'))
  } finally { await second.stop() }
})

for (const mode of ['source', 'bytecode']) test(`${mode}: export a Web-written thumbnail and live KAG bookmark for the original Windows engine`, async () => {
  const program = `
var win=new Window(),image=new Layer(win,null);win.add(image);
image.setImageSize(2,1);image.setMainPixel(0,0,0x123456);image.setMainPixel(1,0,0xabcdef);
var slot=System.dataPath+"Slot.bmp";image.saveLayerImage(slot,"bmp24");
var checkpoint=kagSavePoint();(Dictionary.saveStruct incontextof checkpoint)(slot,"o62");
`
  const { session } = await headless({ ...kagFiles, 'controls.tjs': kagControlSource, 'export.tjs': program,
    'startup.tjs': 'System.exitOnNoWindowStartup=false;Scripts.execStorage("controls.tjs");' + (mode === 'source'
      ? 'Scripts.execStorage("export.tjs");' : 'Scripts.compileStorage("export.tjs","export.cjs",false,true,false);Scripts.execStorage("export.cjs");') })
  try {
    await session.start()
    const files = session.exportSaves('data-directory')
    assert.deepEqual(files.map((f) => f.path), ['Slot.bmp'])
    const slot = Buffer.from(files[0]!.bytes)
    assert.equal(slot.toString('ascii', 0, 2), 'BM'); assert.equal(slot.readUInt32LE(2), 62)
    assert(slot.length > 62)
    assert.equal(await session.evaluate('kagResumePoint(Scripts.evalStorage(slot,"o62"))'), 'Alice|1|Alice|live|1|Alice|live|finished|0|1')
    const zip = Buffer.from(await (await writeNativeSaves(files)).arrayBuffer())
    const dir = resolve('out/ci/web-native-saves')
    await mkdir(dir, { recursive: true })
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    await writeFile(resolve(dir, mode + '.zip'), zip)
    await writeFile(resolve(dir, mode + '.json'), JSON.stringify({
      commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, mode,
      zipSha256: sha(zip), file: 'Slot.bmp', fileSha256: sha(slot), bytes: slot.length,
    }, null, 2))
  } finally { await session.stop() }
})
