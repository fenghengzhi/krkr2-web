import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { embedXp3, xp3Fixture, xp3Signature } from '../helpers/xp3-fixtures.ts'
import { importResources, importSources } from '../../src/backends/files/import-resources.ts'
import type { GameFile } from '../../src/protocol/session.ts'

const file = (path: string, bytes: Uint8Array): GameFile => ({ path, blob: new Blob([Uint8Array.from(bytes).buffer]) })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { resolve, promise }
}
const program = String.raw`
var value=Scripts.evalStorage("value.tjs");
var win=new Window();win.visible=true;win.setInnerSize(4,3);
var root=new Layer(win,null);root.setSize(4,3);root.fillRect(0,0,4,3,0xff123456);
var saved=["embedded:"+value];saved.save("savedata/result.txt","utf-8");
Debug.message("embedded-ready:"+value);
`

for (const binary of [false, true]) for (const compressed of [false, true])
  test(`${binary ? 'bytecode' : 'source'}/${compressed ? 'zlib' : 'raw'}: EXE resources run real TJS with archive paths, overlays and saves`, { timeout: 60000 }, async () => {
    const { session, logs } = await headless(), archive = xp3Fixture({
      'startup.tjs': binary
        ? 'Scripts.compileStorage("game.tjs","savedata/game.cjs",false,true,false);Scripts.execStorage("savedata/game.cjs");'
        : 'Scripts.execStorage("game.tjs");',
      'game.tjs': program, 'value.tjs': '42', 'シーン/other.tjs': '"原档"',
    }, { compressed, continuation: true })
    try {
      session.mount(await importResources([
        file('game.EXE', embedXp3(archive.bytes)), file('value.tjs', Buffer.from('99')),
      ], async () => session.control.check()))
      await session.start()
      assert(logs.includes('embedded-ready:99'))
      assert.equal(await session.evaluate('root.getMainPixel(2,1)'), String(0x123456))
      assert.equal(await session.evaluate('Scripts.evalStorage("game.EXE>value.tjs")'), '42')
      assert.equal(await session.evaluate('Scripts.evalStorage("game.EXE>シーン/other.tjs")'), '原档')
      assert.equal(await session.evaluate('Storages.getPlacedPath("game.EXE>value.tjs")'), 'game://./game.EXE>value.tjs')
      assert.equal(await session.evaluate('(function(){try{saved.save("game.EXE>value.tjs");return false;}catch(error){return true;}})()'), '1')
      const exported = session.exportSaves(), result = exported.find((entry) => entry.path === 'savedata/result.txt')
      assert(result)
      assert.match(new TextDecoder().decode(result.bytes), /embedded:99/)
      if (binary) {
        const compiled = exported.find((entry) => entry.path === 'savedata/game.cjs')
        assert(compiled)
        assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
      }
      session.pause()
      await session.importSaves([{ path: 'value.tjs', bytes: Buffer.from('113') }])
      session.resume()
      assert.equal(await session.evaluate('Scripts.evalStorage("value.tjs")'), '113')
      assert.equal(await session.evaluate('Scripts.evalStorage("game.EXE>value.tjs")'), '42')
    } finally { await session.stop() }
    assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
  })

test('invalid first embedded archive cannot partially replace an existing Session mount', { timeout: 60000 }, async () => {
  const { session } = await headless({ 'answer.tjs': '7' }),
    valid = embedXp3(xp3Fixture({ 'answer.tjs': '42' }).bytes, 128), invalid = Buffer.from(valid)
  invalid.set(xp3Signature, 16)
  invalid.writeBigUInt64LE(BigInt(invalid.length), 27)
  try {
    const initial = session.snapshot().resources
    await assert.rejects(importResources([file('good.exe', valid), file('bad.exe', invalid)], async () => {})
      .then((resources) => session.mount(resources)), /outside valid range/)
    assert.equal(session.snapshot().resources, initial)
    assert.equal(await session.evaluate('Scripts.evalStorage("answer.tjs")'), '7')
  } finally { await session.stop() }
})

test('Stop while scanning an executable prefix prevents publication and ignores the released read', { timeout: 60000 }, async () => {
  const { session } = await headless(), bytes = embedXp3(xp3Fixture({ 'startup.tjs': '1' }).bytes),
    entered = deferred(), release = deferred(), reads: [number, number][] = []
  try {
    const preparing = importSources([{ path: 'game.exe', source: { size: bytes.length,
      async read(offset, length) {
        reads.push([offset, length])
        if (offset === 16) { entered.resolve(); await release.promise }
        return bytes.subarray(offset, offset + length)
      },
    } }], async () => session.control.check()).then((resources) => session.mount(resources)),
      rejected = assert.rejects(preparing)
    await entered.promise
    await session.stop()
    release.resolve()
    await rejected
    assert.equal(session.snapshot().resources, 0)
    assert.equal(session.snapshot().state, 'stopped')
    assert(!reads.some(([offset]) => offset > 16), 'No later scan block or archive index may be read after Stop')
  } finally { release.resolve(); await session.stop() }
})
