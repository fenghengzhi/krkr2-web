import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'
import { importResources } from '../../src/backends/files/import-resources.ts'
import type { GameFile } from '../../src/protocol/session.ts'

const file = (path: string, bytes: Uint8Array): GameFile => ({
  path,
  blob: new Blob([Uint8Array.from(bytes).buffer]),
})
const checkpoint = async () => {}
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

test('ZIP import runs real TJS and images, preserving mount order, qualified paths and save overrides', async () => {
  const { session, logs } = await headless()
  try {
    const resources = await importResources(
      [file('base.ZIP', zipFixture()), file('シーン/value.tjs', Buffer.from('99'))],
      checkpoint,
    )
    session.mount(resources)
    await session.start()
    assert.ok(logs.includes('zip-ready:99:0'))
    assert.equal(await session.evaluate('asset.getMainPixel(0,0)'), String(0x336699))
    assert.equal(await session.evaluate('Scripts.evalStorage("base.ZIP>シーン/value.tjs")'), '42')
    assert.equal(
      await session.evaluate('Storages.getPlacedPath("base.ZIP>シーン/value.tjs")'),
      'base.ZIP>シーン/value.tjs',
    )
    assert.equal(session.exportSaves().length, 1)
    session.pause()
    await session.importSaves([{ path: 'シーン/value.tjs', bytes: Buffer.from('113') }])
    session.resume()
    assert.equal(await session.evaluate('Scripts.evalStorage("シーン/value.tjs")'), '113')
    assert.equal(await session.evaluate('Scripts.evalStorage("base.ZIP>シーン/value.tjs")'), '42')
    assert.equal(
      await session.evaluate(
        '(function(){try{saved.save("base.ZIP>empty.bin");return false;}catch(e){return true;}})()',
      ),
      '1',
    )
    assert.equal(
      await session.evaluate(
        '(function(){Storages.addAutoPath("base.ZIP>folder/");return Storages.getPlacedPath("CAFÉ.TXT");})()',
      ),
      'base.ZIP>folder/café.txt',
    )
    assert.equal(
      await session.evaluate(
        '(function(){var count=0,d=%[];try{(Dictionary.saveStruct incontextof d)("base.ZIP>empty.bin","b");}catch(e){count++;}try{saved.save("../escape.txt");}catch(e){count++;}try{saved.save("savedata/offset.txt","o67108865");}catch(e){count++;}saved.save("savedata/after.txt","utf-8");return count;})()',
      ),
      '3',
    )
    assert.equal(session.snapshot().pendingSaves, 0)
    assert.equal(session.exportSaves().length, 3)
  } finally {
    await session.stop()
  }
})

test('archive recognition uses ZIP signatures and a failed batch leaves the previous mount intact', async () => {
  const { session } = await headless({ 'answer.tjs': '7' })
  try {
    const initial = session.snapshot().resources
    await assert.rejects(
      importResources(
        [file('valid.zip', zipFixture()), file('bad.zip', Buffer.from('invalid'))],
        checkpoint,
      ),
      /ZIP/,
    )
    assert.equal(session.snapshot().resources, initial)
    const resources = await importResources(
      [file('renamed.data', zipFixture()), file('empty.ZIP', zipFixture('empty.zip'))],
      checkpoint,
    )
    session.mount(resources)
    assert.equal(
      await session.evaluate('Scripts.evalStorage("renamed.data>シーン/value.tjs")'),
      '42',
    )
    assert.equal(await session.evaluate('Scripts.evalStorage("answer.tjs")'), '7')
    assert.equal(await session.evaluate('Storages.isExistentStorage("empty.ZIP")'), '1')
    await assert.rejects(
      importResources([file('fake>injected.tjs', Buffer.from('1'))], checkpoint),
      /delimiter/,
    )
  } finally {
    await session.stop()
  }
})

test('stopping a pending archive import prevents publication and late completion', async () => {
  const { session } = await headless(),
    entered = deferred(),
    release = deferred()
  let first = true
  try {
    const preparing = importResources([file('game.zip', zipFixture())], async () => {
      if (first) {
        first = false
        entered.resolve()
        await release.promise
      }
      session.control.check()
    }).then((resources) => session.mount(resources))
    await entered.promise
    const stopped = session.stop()
    release.resolve()
    const results = await Promise.allSettled([preparing, stopped])
    assert.equal(results[0]!.status, 'rejected')
    assert.equal(results[1]!.status, 'fulfilled')
    assert.equal(session.snapshot().state, 'stopped')
    assert.equal(session.snapshot().resources, 0)
  } finally {
    await session.stop()
  }
})
