import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { headless } from '../helpers/headless.ts'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'

const dumpPath = 'savedata/krkr2-web.dump.txt'
const dumpText = (files: SaveFile[]) => {
  const file = files.find((f) => f.path === dumpPath)
  assert(file, 'Missing script dump')
  assert.deepEqual([...file.bytes.subarray(0, 2)], [255, 254])
  return Buffer.from(file.bytes).toString('utf16le')
}

test('VM warnings enter Debug history, observers and the persistent log before the source executes', async () => {
  const { session, logs } = await headless({
    'startup.tjs': `var observed=0,seen="";
      Debug.startLogToFile();
      Debug.addLoggingHandler(function(line){observed++;seen=line;Scripts.execStorage("observer.tjs");});
      Scripts.execStorage("warning.tjs");`,
    'warning.tjs': 'var warningValue=0;if(warningValue=1){}',
    'observer.tjs': 'var observedBeforeExecution=typeof global.warningValue;',
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('observed'), '1')
    assert.equal(await session.evaluate('observedBeforeExecution'), 'undefined')
    assert.equal(await session.evaluate('warningValue'), '1')
    assert.match(await session.evaluate('seen'), /warning.tjs.*line 1/)
    assert.match(await session.evaluate('Debug.getLastLog(1)'), /warning.tjs/)
    assert.equal(logs.length, 1)
    const file = session.exportSaves().find((f) => f.path.endsWith('krkr.console.log'))!
    assert.match(Buffer.from(file.bytes).toString('utf16le'), /warning.tjs/)
  } finally {
    await session.stop()
  }
})

test('Scripts.dump writes UTF-16 independently of observers and a later session replaces the old dump', async () => {
  const store = new MemorySaveStore(),
    first = await headless(
      {
        'startup.tjs': `var marker="dump-first-marker",observed=0;
      Debug.addLoggingHandler(function(line){observed++;Scripts.execStorage("observer.tjs");});Scripts.dump();`,
        'observer.tjs': 'global.laterDumpFunction=function(){return "observer-only-block";};',
      },
      { saveStore: store },
    )
  try {
    await first.session.start()
    const text = dumpText(first.session.exportSaves())
    assert.match(text, /TJS Context Dump/)
    assert.match(text, /dump-first-marker/)
    assert(!text.includes('observer-only-block'))
    assert.equal(await first.session.evaluate('observed'), '1')
    assert.deepEqual(first.logs, ['Dumped to ' + dumpPath])
    assert.equal(dumpText(await store.load()), text)
  } finally {
    await first.session.stop()
  }
  const second = await headless(
    { 'startup.tjs': 'var marker="dump-second-marker";Scripts.dump();' },
    { saveStore: store },
  )
  try {
    await second.session.start()
    const text = dumpText(second.session.exportSaves())
    assert.match(text, /dump-second-marker/)
    assert(!text.includes('dump-first-marker'))
    assert.equal(dumpText(await store.load()), text)
  } finally {
    await second.session.stop()
  }
})

test('dump-only commit failures keep the VM running and an explicit later dump retries persistence', async () => {
  class Store extends MemorySaveStore {
    broken = true
    commits = 0
    override async commit(files: SaveFile[]) {
      this.commits++
      if (this.broken) throw new Error('dump-store-quota')
      await super.commit(files)
    }
  }
  const store = new Store(),
    { session, logs } = await headless(
      { 'startup.tjs': 'Scripts.dump();var alive=1;' },
      { saveStore: store },
    )
  try {
    await session.start()
    assert.equal(session.snapshot().state, 'running')
    assert.equal(await session.evaluate('alive'), '1')
    assert.match(dumpText(session.exportSaves()), /TJS Context Dump/)
    assert.equal(session.snapshot().pendingSaves, 1)
    assert.equal(store.commits, 1)
    assert(logs.some((line) => line.includes('dump-store-quota')))
    store.broken = false
    await session.evaluate('Scripts.dump()')
    assert.equal(store.commits, 2)
    assert.equal(session.snapshot().pendingSaves, 0)
    assert.match(dumpText(await store.load()), /TJS Context Dump/)
  } finally {
    store.broken = false
    await session.stop()
  }
})

test('dump output does not downgrade a pending game write to the same path', async () => {
  class Store extends MemorySaveStore {
    broken = true
    override async commit(files: SaveFile[]) {
      if (this.broken) throw new Error('critical-dump-path')
      await super.commit(files)
    }
  }
  const store = new Store(),
    { session } = await headless(
      {
        'startup.tjs': '["explicit-game-write"].save("' + dumpPath + '");Scripts.dump();',
      },
      { saveStore: store },
    )
  try {
    await assert.rejects(session.start(), /critical-dump-path/)
    assert.equal(session.snapshot().state, 'failed')
    assert.match(dumpText(session.exportSaves()), /TJS Context Dump/)
  } finally {
    store.broken = false
    await session.stop()
  }
})

test('a full save overlay rejects only the optional dump and preserves existing game bytes', async () => {
  const store = new MemorySaveStore(),
    full = new Uint8Array(64 * 1024 * 1024)
  full[0] = 17
  full[full.length - 1] = 91
  await store.commit([{ path: 'savedata/full.bin', bytes: full }])
  const { session, logs } = await headless(
    { 'startup.tjs': 'Scripts.dump();var alive=1;' },
    { saveStore: store },
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('alive'), '1')
    const files = session.exportSaves()
    assert.equal(files.length, 1)
    assert.equal(files[0]!.bytes[0], 17)
    assert.equal(files[0]!.bytes.at(-1), 91)
    assert(logs.some((line) => line.includes('转储无法写入')))
    assert(!logs.some((line) => line.startsWith('Dumped to ')))
  } finally {
    await session.stop()
  }
})

test(
  'stopping a large native dump cancels collection without publishing partial output',
  { timeout: 10000 },
  async () => {
    const { session } = await headless({
      'startup.tjs': `
    var retained=[];for(var i=0;i<2000;i++)retained.add(Scripts.eval("function(){return "+i+";}"));
  `,
    })
    await session.start()
    const pending = session.evaluate('Scripts.dump()')
    const rejected = assert.rejects(pending, /Execution cancelled/)
    await delay(1)
    await session.stop()
    await rejected
    assert.equal(session.snapshot().state, 'stopped')
    assert.equal(session.snapshot().handles, 0)
    assert(!session.exportSaves().some((f) => f.path === dumpPath))
  },
)
