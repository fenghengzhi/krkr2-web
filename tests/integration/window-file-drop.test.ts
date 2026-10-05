import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import type { DropResourceTree } from '../../src/engine/ports/storage-drop.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var events=[],keep=null,finalized=0,dropHook=null;
class DropWindow extends Window {
  var label;
  function DropWindow(label){super.Window();this.label=label;caption=label;setInnerSize(32,24);visible=true;}
  function onFileDrop(files){
    if(!(files instanceof "Array"))throw new Exception("drop did not receive an Array");
    global.keep=files;var names=[];
    for(var i=0;i<files.count;i++)names.add(Storages.extractStorageName(files[i]));
    global.events.add(label+":"+names.join(","));
    if(global.dropHook!==null)global.dropHook(files);
  }
  function finalize(){global.finalized++;}
}
var a=new DropWindow("A"),b=new DropWindow("B");
`
function bytes(value: string | Uint8Array) {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value.slice()
  return { size: data.length, async read(offset: number, length: number) { return data.slice(offset, offset + length) } }
}
function files(...values: [string, string | Uint8Array][]): DropResourceTree {
  return { roots: values.map(([name]) => ({ name, kind: 'file' })),
    entries: values.map(([, value], root) => ({ root, path: '', kind: 'file', source: bytes(value) })) }
}
async function fixture(binary: boolean, overrides: Partial<SessionDependencies> = {}) {
  const f = await headless({ 'startup.tjs': binary
    ? 'Scripts.compileStorage("drop.tjs","savedata/drop.cjs",false,true,false);Scripts.execStorage("savedata/drop.cjs");'
    : 'Scripts.execStorage("drop.tjs");', 'drop.tjs': source }, overrides)
  await f.session.start()
  const execute = (code: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(code)})`),
    id = (caption: string) => {
      const window = f.session.snapshot().windows?.find((entry) => entry.view.caption === caption)
      assert.ok(window, `Missing Window ${caption}`)
      return window.id
    }
  let sequence = 0
  return { ...f, execute, id,
    drop: (tree: DropResourceTree, caption = 'A', epoch = 0) =>
      f.session.acceptFileDrop({ windowId: id(caption), surfaceEpoch: epoch, sequence: ++sequence }, tree),
    async stop() {
      await f.session.stop()
      assert.equal(f.session.snapshot().handles, 0)
      assert(Object.values(f.session.inspectOwnership()).every((count) => count === 0))
    },
  }
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: file drops deliver one real reverse-ordered Array to the inactive Window and default action preserves it`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.execute(`
var defaultWindow=new Window();defaultWindow.caption="Default";defaultWindow.visible=true;
var actionFiles=null,actionTarget=null,manual=[],extra=0,minArgs=0,layerDrops=0;
defaultWindow.action=function(event){if(event.type=="onFileDrop"){global.actionFiles=event.files;global.actionTarget=event.target;}};
try{defaultWindow.onFileDrop();}catch(error){minArgs++;}
defaultWindow.onFileDrop(manual,++extra);
var layer=new Layer(a,null);a.add(layer);layer.onFileDrop=function(){global.layerDrops++;};
`)
      assert.equal(await f.session.evaluate('minArgs+","+extra+","+int(actionFiles===manual)+","+int(actionTarget===defaultWindow)'), '1,1,1,1')
      const admission = await f.drop(files(['first.txt', 'first'], ['last.txt', 'last']))
      assert.equal(admission.status, 'accepted'); await admission.completion
      assert.equal(await f.session.evaluate('events.join("|")+"|"+layerDrops+"|"+[].load(keep[0],"utf-8")[0]+","+[].load(keep[1],"utf-8")[0]'), 'A:last.txt,first.txt|0|last,first')
      const defaultDrop = await f.drop(files(['actual.txt', 'actual']), 'Default')
      await defaultDrop.completion
      assert.equal(await f.session.evaluate('int(actionFiles instanceof "Array")+","+int(actionTarget===defaultWindow)+","+[].load(actionFiles[0],"utf-8")[0]'), '1,1,actual')
      assert.deepEqual(f.logs, [])
    } finally { await f.stop() }
  })

  test(`${mode}: dropped directories preserve empty metadata and archive bytes without changing cwd or old file identities`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const first = await f.drop(files(['same.txt', 'old'])); await first.completion
      await f.execute('var old=keep[0],cwd=System.exePath;')
      const directory: DropResourceTree = { roots: [{ name: 'folder', kind: 'directory' }, { name: 'same.txt', kind: 'file' }], entries: [
        { root: 0, path: '', kind: 'directory' }, { root: 0, path: 'empty', kind: 'directory' },
        { root: 0, path: 'nested.txt', kind: 'file', source: bytes('inside') },
        { root: 0, path: 'bundle.zip', kind: 'file', source: bytes(zipFixture()) },
        { root: 1, path: '', kind: 'file', source: bytes('new') },
      ] }
      const next = await f.drop(directory); await next.completion
      assert.equal(await f.session.evaluate('int(old!==keep[0])+"|"+[].load(old,"utf-8")[0]+"|"+[].load(keep[0],"utf-8")[0]+"|"+[].load(keep[1]+"nested.txt","utf-8")[0]+"|"+Scripts.evalStorage(keep[1]+"bundle.zip>シーン/value.tjs")+"|"+int(cwd==System.exePath)'), '1|old|new|inside|42|1')
      const selecting = f.session.evaluate('Storages.selectFile(%[title:"Dropped empty",initialDir:keep[1]+"empty/"])')
      void selecting.catch(() => {})
      const until = Date.now() + 10000
      let request: Extract<(typeof f.events)[number], { type: 'system-dialog' }>['request'] | undefined
      while (!(request = [...f.events].reverse().find((event) => event.type === 'system-dialog')?.request)) {
        assert(Date.now() < until); await new Promise((resolve) => setTimeout(resolve, 1))
      }
      assert.equal(request.kind, 'storage-selector')
      if (request.kind === 'storage-selector') {
        assert.match(request.selector.initialDirectory, /\/folder\/empty\/$/)
        assert.equal(request.selector.entries.length, 0)
      }
      assert.equal(await f.session.selectSystemDialog(request.id, null), true)
      assert.equal(await selecting, '0')
      await f.execute('var denied=0;try{["overwrite"].save(old,"utf-8");}catch(error){denied++;}')
      assert.equal(await f.session.evaluate('denied+"|"+[].load(old,"utf-8")[0]'), '1|old')
    } finally { await f.stop() }
  })

  test(`${mode}: eventDisabled holds distinct drop events in order and Window retirement never retains its weak callback owner`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('System.eventDisabled=true;')
      const first = await f.drop(files(['one.txt', '1'])), second = await f.drop(files(['two.txt', '2']))
      assert.equal(await f.session.evaluate('events.count'), '0')
      await f.execute('System.eventDisabled=false;')
      await Promise.all([first.completion, second.completion])
      assert.equal(await f.session.evaluate('events.join("|")'), 'A:one.txt|A:two.txt')
      await f.execute('System.eventDisabled=true;')
      const retired = await f.drop(files(['never.txt', 'not delivered']))
      await f.execute('delete global.a;System.eventDisabled=false;')
      await retired.completion
      assert.equal(await f.session.evaluate('finalized+"|"+events.join("|")'), '1|A:one.txt|A:two.txt')
      assert.equal(f.session.inspectOwnership().windowSources, 1)
    } finally { await f.stop() }
  })

  test(`${mode}: stale epochs, hidden targets and sequence replay do not publish dropped resources`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const count = f.session.snapshot().resources, identity = { windowId: f.id('A'), surfaceEpoch: 0, sequence: 100 }
      assert.equal((await f.drop(files(['stale.txt', 'stale']), 'A', 1)).status, 'ignored')
      await f.execute('a.visible=false;')
      assert.equal((await f.drop(files(['hidden.txt', 'hidden']))).status, 'ignored')
      assert.equal(f.session.snapshot().resources, count)
      await f.execute('a.visible=true;')
      const accepted = await f.session.acceptFileDrop(identity, files(['once.txt', 'once']))
      await accepted.completion
      const after = f.session.snapshot().resources
      assert.equal((await f.session.acceptFileDrop(identity, files(['replay.txt', 'replay']))).status, 'ignored')
      assert.equal(f.session.snapshot().resources, after)
      assert.equal(await f.session.evaluate('events.join("|")'), 'A:once.txt')
    } finally { await f.stop() }
  })

  test(`${mode}: explicit cancellation before metadata commit releases both admission slots and a later drop works`, { timeout: 60000 }, async () => {
    let hold = false, entered = false, release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), f = await fixture(binary, {
      yieldToHost: async () => { if (hold) { entered = true; await gate } },
    })
    try {
      const count = f.session.snapshot().resources, identity = { windowId: f.id('A'), surfaceEpoch: 0, sequence: 1 }
      hold = true
      const admitting = f.session.acceptFileDrop(identity, files(['cancelled.txt', 'cancelled']))
      const until = Date.now() + 10000
      while (!entered) { assert(Date.now() < until); await new Promise((resolve) => setTimeout(resolve, 1)) }
      f.session.cancelFileDrop(identity)
      assert.equal((await admitting).status, 'ignored')
      assert.equal(f.session.snapshot().resources, count)
      hold = false; release()
      const accepted = await f.session.acceptFileDrop({ ...identity, sequence: 2 }, files(['valid.txt', 'ok']))
      await accepted.completion
      assert.equal(await f.session.evaluate('events.join("|")'), 'A:valid.txt')
    } finally { hold = false; release(); await f.stop() }
  })

  test(`${mode}: Stop unblocks a staged drop before its borrowed checkpoint returns`, { timeout: 60000 }, async () => {
    let hold = false, entered = false, release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), f = await fixture(binary, {
      yieldToHost: async () => { if (hold) { entered = true; await gate } },
    })
    try {
      hold = true
      const admitting = f.drop(files(['stopped.txt', 'stopped']))
      const until = Date.now() + 10000
      while (!entered) { assert(Date.now() < until); await new Promise((resolve) => setTimeout(resolve, 1)) }
      await f.stop()
      assert.equal((await admitting).status, 'ignored')
    } finally { hold = false; release(); await f.stop() }
  })
}
