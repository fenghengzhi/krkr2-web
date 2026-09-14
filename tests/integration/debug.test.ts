import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { headless } from '../helpers/headless.ts'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'
const epoch = new Date(2026, 8, 14, 12, 34, 56).getTime(),
  file = 'savedata/krkr.console.log',
  content = (files: SaveFile[], path = file) => {
    const bytes = files.find((f) => f.path === path)?.bytes
    assert(bytes, 'Missing log file: ' + path)
    return Buffer.from(bytes).toString('utf16le')
  }

test('Debug bridge keeps variadic coercion, required arguments, properties and unsigned history counts', async () => {
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var failures=0;
Debug.message("hello",12,void);
Debug.notice("important",-7);
Debug.logToFileOnError=false;Debug.clearLogFileOnError=true;
Debug.logAsError();
`,
    },
    { wallNow: () => epoch },
  )
  try {
    await session.start()
    assert.deepEqual(logs, ['hello, 12, ', 'important, -7'])
    assert.equal(await session.evaluate('Debug.getLastLog(1)'), '12:34:56 important, -7\r\n')
    assert.equal(await session.evaluate('Debug.getLastLog(4294967296)'), '')
    assert.equal(await session.evaluate('Debug.getLastLog(void)'), '')
    assert.equal(
      await session.evaluate('Debug.getLastLog(-1)'),
      '12:34:56 hello, 12, \r\n12:34:56 important, -7\r\n',
    )
    assert.equal(
      await session.evaluate(
        '[Debug.logLocation,Debug.logToFileOnError,Debug.clearLogFileOnError].join("|")',
      ),
      'savedata/|0|1',
    )
    assert.equal(session.exportSaves().length, 0)
    await session.evaluate(`(function(){
      try{Debug.message();}catch(e){failures++;}
      try{Debug.notice();}catch(e){failures++;}
      try{Debug.addLoggingHandler();}catch(e){failures++;}
      try{Debug.removeLoggingHandler();}catch(e){failures++;}
    })()`)
    assert.equal(await session.evaluate('failures'), '4')
    assert(logs.slice(2).some((line) => line.includes('Disassembled VM code')))
    assert.match(await session.evaluate('Debug.getLastLog()'), /Missing logging handler/)
  } finally {
    await session.stop()
  }
})

test('logging handlers preserve bound identity, live removals/appends and recursive message ordering', async () => {
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var order="",seen=[];
function c(line){order+="C";seen.add(line);}
function b(line){order+="B";}
function a(line){order+="A";Debug.message("nested");Debug.removeLoggingHandler(b);Debug.addLoggingHandler(c);Debug.removeLoggingHandler(a);}
Debug.startLogToFile();
Debug.addLoggingHandler(a);Debug.addLoggingHandler(a);Debug.addLoggingHandler(b);
Debug.addLoggingHandler(%[]);Debug.addLoggingHandler(null);
Debug.message("outer");
Debug.removeLoggingHandler(c);
class Item {
  var name;
  function Item(value){name=value;}
  function log(line){order+=name;Debug.removeLoggingHandler(log);}
}
var x=new Item("X"),y=new Item("Y");
Debug.addLoggingHandler(x.log);Debug.addLoggingHandler(x.log);Debug.addLoggingHandler(y.log);
Debug.message("bound");
`,
    },
    { wallNow: () => epoch },
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('order'), 'ACXY')
    assert.equal(await session.evaluate('seen.join("|")'), '12:34:56 outer')
    assert.deepEqual(logs, ['nested', 'outer', 'bound'])
    assert.equal(
      await session.evaluate('Debug.getLastLog()'),
      '12:34:56 outer\r\n12:34:56 nested\r\n12:34:56 bound\r\n',
    )
    assert(
      content(session.exportSaves()).endsWith(
        '12:34:56 nested\r\n12:34:56 outer\r\n12:34:56 bound\r\n',
      ),
    )
  } finally {
    await session.stop()
  }
  assert.equal(session.snapshot().handles, 0)
})

test('a throwing logging handler is removed, preserves its original exception and stops only that delivery', async () => {
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var order="",caught="";
function broken(line){order+="A";throw new Exception("handler-original");}
function remaining(line){order+="B";}
Debug.addLoggingHandler(broken);Debug.addLoggingHandler(remaining);
try{Debug.message("suppressed");}catch(error){caught=error.message;}
Debug.message("survives");
`,
    },
    { wallNow: () => epoch },
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('order'), 'AB')
    assert.equal(await session.evaluate('caught'), 'handler-original')
    assert.deepEqual(logs, ['survives'])
    assert.equal(
      await session.evaluate('Debug.getLastLog()'),
      '12:34:56 suppressed\r\n12:34:56 survives\r\n',
    )
  } finally {
    await session.stop()
  }
})

test('logging handlers can suspend for script and file reads without reentering the WASM runtime', async () => {
  const { session, logs } = await headless(
    {
      'startup.tjs': `
var captured="";
function observer(line){Scripts.execStorage("observer.tjs");Debug.message("nested-async");}
Debug.addLoggingHandler(observer);Debug.startLogToFile();Debug.message("outer-async");
var saved=new Array();saved.load("savedata/krkr.console.log");var stored=saved.join("\\n");
`,
      'observer.tjs': 'captured=Debug.getLastLog(1);',
    },
    { wallNow: () => epoch },
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('captured'), '12:34:56 outer-async\r\n')
    assert.deepEqual(logs, ['nested-async', 'outer-async'])
    assert((await session.evaluate('stored')).includes('outer-async'))
  } finally {
    await session.stop()
  }
})

test('log files survive session restart and explicit clear does not retain earlier runs', async () => {
  const store = new MemorySaveStore()
  for (const [label, clear] of [
    ['one', false],
    ['two', false],
    ['three', true],
  ] as const) {
    const { session } = await headless(
      { 'startup.tjs': `Debug.startLogToFile(${clear});Debug.message("${label}");` },
      { saveStore: store, wallNow: () => epoch },
    )
    await session.start()
    await session.stop()
    const text = content(await store.load())
    assert(text.endsWith('12:34:56 ' + label + '\r\n'))
    assert.equal((text.match(/\ufeff/g) ?? []).length, 1)
    if (label === 'two') assert(text.includes('12:34:56 one\r\n'))
    if (label === 'three') {
      assert(!text.includes('12:34:56 one\r\n'))
      assert(!text.includes('12:34:56 two\r\n'))
    }
  }
})

test('a primary script exception survives a simultaneous commit failure and its log remains exportable', async () => {
  class Store extends MemorySaveStore {
    fail = true
    override async commit(files: SaveFile[]) {
      if (this.fail) throw new Error('disk-failure')
      await super.commit(files)
    }
  }
  const store = new Store(),
    { session, logs } = await headless(
      {
        'startup.tjs':
          '["user-save"].save("savedata/user.txt");Debug.notice("context");throw new Exception("primary-script-error");',
      },
      { saveStore: store, wallNow: () => epoch },
    )
  await assert.rejects(session.start(), /primary-script-error/)
  assert.equal(session.snapshot().state, 'failed')
  assert(logs.some((line) => line.includes('disk-failure')))
  assert.equal(logs.filter((line) => line === 'script exception : primary-script-error').length, 1)
  const exported = content(session.exportSaves())
  assert(exported.includes('! context'))
  assert(exported.includes('primary-script-error'))
  assert.equal(session.snapshot().pendingSaves, 2)
  await assert.rejects(session.stop(), /disk-failure/)
  store.fail = false
  await session.stop()
  assert.equal(content(await store.load()), exported)
  assert.equal(session.snapshot().handles, 0)
})

test('automatic error logging commits a startup failure before rejection and honors the opt-out flag', async () => {
  for (const enabled of [true, false]) {
    const store = new MemorySaveStore(),
      { session } = await headless(
        {
          'startup.tjs': `Debug.logToFileOnError=${enabled};Debug.message("before-error");throw new Exception("fatal");`,
        },
        { saveStore: store, wallNow: () => epoch },
      )
    try {
      await assert.rejects(session.start(), /fatal/)
      const files = await store.load()
      if (enabled) {
        assert(content(files).includes('before-error'))
        assert(content(files).includes('fatal'))
      } else assert.deepEqual(files, [])
    } finally {
      await session.stop()
    }
  }
})

test('stopping an infinite logging observer releases the suspended callback and fresh sessions still work', async () => {
  const { session } = await headless({
    'startup.tjs':
      'Debug.addLoggingHandler(function(line){while(true){}});Debug.message("stopping");',
  })
  const running = session.start().catch((error) => error)
  await delay(40)
  await session.stop()
  assert.match(String(await running), /cancel/i)
  assert.equal(session.snapshot().handles, 0)
  const fresh = await headless({ 'startup.tjs': 'Debug.message("fresh");' })
  try {
    await fresh.session.start()
    assert.deepEqual(fresh.logs, ['fresh'])
  } finally {
    await fresh.session.stop()
  }
})

test('logging observers see uncaught script diagnostics before cancellation, and observer failure preserves the primary error', async () => {
  for (const broken of [false, true]) {
    const store = new MemorySaveStore(),
      { session, logs } = await headless(
        {
          'startup.tjs': `
Debug.addLoggingHandler(function(line){
 if(line.indexOf("primary-observed")<0)return;
 [line].save("savedata/observed.txt");
 ${broken ? 'throw new Exception("observer-failure");' : ''}
});
throw new Exception("primary-observed");
`,
        },
        { saveStore: store, wallNow: () => epoch },
      )
    try {
      await assert.rejects(session.start(), /primary-observed/)
      const files = await store.load()
      assert(content(files, 'savedata/observed.txt').includes('primary-observed'))
      assert(content(files).includes('primary-observed'))
      if (broken) assert(logs.some((line) => line.includes('observer-failure')))
    } finally {
      await session.stop()
    }
  }
})

test('a full game save budget cannot turn optional log output into an unexportable or unstoppable session', async () => {
  const original = new Uint8Array(64 * 1024 * 1024)
  original[0] = 17
  original[original.length - 1] = 93
  const { session, logs } = await headless(
    { 'startup.tjs': 'Debug.startLogToFile();Debug.message("full-save-log");var continued=true;' },
    {
      saveStore: {
        load: async () => [{ path: 'savedata/full.bin', bytes: original }],
        commit: async () => {},
        close() {},
      },
    },
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('continued'), '1')
    await session.evaluate('Debug.message("after-full-log")')
    assert(logs.some((line) => line.includes('日志文件无法写入')))
    const exported = session.exportSaves()
    assert.equal(exported.length, 1)
    assert.equal(exported[0]!.bytes.length, original.length)
    assert.equal(exported[0]!.bytes[0], 17)
    assert.equal(exported[0]!.bytes.at(-1), 93)
  } finally {
    await session.stop()
  }
  assert.equal(session.snapshot().state, 'stopped')
})

test('a diagnostic-only transaction failure keeps scripts running, avoids retry loops and never blocks stopping', async () => {
  for (const repair of [false, true]) {
    class Store extends MemorySaveStore {
      broken = true
      commits = 0
      override async commit(files: SaveFile[]) {
        this.commits++
        if (this.broken) throw new Error('diagnostic-only-quota')
        await super.commit(files)
      }
    }
    const store = new Store(),
      { session, logs } = await headless(
        { 'startup.tjs': 'Debug.startLogToFile();Debug.message("before-quota");var alive=true;' },
        { saveStore: store, wallNow: () => epoch },
      )
    await session.start()
    assert.equal(session.snapshot().state, 'running')
    assert.equal(session.snapshot().pendingSaves, 1)
    const exported = content(session.exportSaves())
    assert(exported.includes('before-quota'))
    for (let i = 0; i < 3; i++) await session.evaluate('Debug.message("after-quota")')
    assert.equal(store.commits, 1)
    assert(logs.some((line) => line.includes('diagnostic-only-quota')))
    assert.equal(await session.evaluate('alive'), '1')
    store.broken = !repair
    await session.stop()
    assert.equal(session.snapshot().state, 'stopped')
    assert.equal(session.snapshot().handles, 0)
    assert.equal(store.commits, 2)
    if (repair) assert.equal(content(await store.load()), exported)
    else assert.deepEqual(await store.load(), [])
  }
})

test('appending diagnostics never downgrades an explicit game write to the same log filename', async () => {
  class Store extends MemorySaveStore {
    broken = true
    override async commit(files: SaveFile[]) {
      if (this.broken) throw new Error('critical-game-write')
      await super.commit(files)
    }
  }
  const store = new Store(),
    { session } = await headless(
      {
        'startup.tjs':
          '["explicit-game-payload"].save("savedata/krkr.console.log");Debug.startLogToFile();Debug.message("append");',
      },
      { saveStore: store, wallNow: () => epoch },
    )
  await assert.rejects(session.start(), /critical-game-write/)
  assert.equal(session.snapshot().state, 'failed')
  const exported = content(session.exportSaves())
  assert(exported.includes('explicit-game-payload'))
  assert(exported.includes('append'))
  await assert.rejects(session.stop(), /critical-game-write/)
  store.broken = false
  await session.stop()
  assert.equal(content(await store.load()), exported)
})
