import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  isScriptObject,
  type HostReply,
  type ScriptObject,
  type ScriptValue,
} from '../../src/engine/script/runtime.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
const defaults: ScriptValue[] = [0n, '', '', undefined, 0n, undefined, 0n]

/** Observes native conversions and writeback, not a substitute UI/resolver.
 * A retained real TJS continuation exercises the native call's suspended stack. */
async function boundary(answer: ScriptValue = undefined) {
  const calls: { operation: string; args: ScriptValue[] }[] = []
  const identities: bigint[] = []
  const aborted: bigint[] = []
  const open = new Set<bigint>()
  const lifecycle: string[] = []
  const faults: { selection?: string; abort?: string; invokeAbort?: boolean } = {}
  let callback: ScriptObject | undefined
  let selected = answer
  const vm = await TjsWasmRuntime.create(
    factory,
    async (operation, args, context): Promise<HostReply> => {
      if (operation === 'Factory')
        return {
          kind: 'value',
          value: {
            type: 'class',
            namespace: 'Storages',
            className: 'Storages',
            id: 0,
            properties: [],
          },
        }
      if (operation === 'Capture') {
        assert(isScriptObject(args[0]))
        if (callback) context.release(callback)
        callback = context.retain(args[0])
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Storages.selectFileAbort') {
        assert.equal(args.length, 1)
        const identity = args[0]
        assert(typeof identity === 'bigint')
        assert(identities.includes(identity), 'Only the exact opened request may be aborted')
        assert(!aborted.includes(identity), 'Each native request attempts cleanup once')
        aborted.push(identity)
        open.delete(identity)
        lifecycle.push(`abort:${identity}`)
        if (faults.abort) throw new Error(faults.abort)
        if (faults.invokeAbort) {
          assert(callback)
          return { kind: 'invoke', callback, args: [] }
        }
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Storages.selectFile') {
        const identity = args[0]
        assert(typeof identity === 'bigint')
        assert(identity > 0n && identity <= BigInt(Number.MAX_SAFE_INTEGER))
        assert(identity > (identities.at(-1) ?? 0n), 'Request IDs increase across class factories')
        identities.push(identity)
        open.add(identity)
        lifecycle.push(`select:${identity}`)
        args = args.slice(1)
      }
      calls.push({ operation, args: [...args] })
      if (operation === 'Trace') {
        lifecycle.push(`trace:${String(args[0])}`)
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Answer') return { kind: 'value', value: selected }
      if (operation === 'Storages.selectFilePath') {
        assert.equal(args.length, 1)
        assert(typeof args[0] === 'string')
        if (args[0] === 'reject-path') throw new Error('selector-path-rejected')
        return {
          kind: 'value',
          value: args[0].startsWith('game://./') ? args[0] : `game://./${args[0]}`,
        }
      }
      assert.equal(operation, 'Storages.selectFile')
      assert(
        args.every((value) => value === undefined || ['bigint', 'string'].includes(typeof value)),
      )
      await Promise.resolve()
      if (faults.selection) throw new Error(faults.selection)
      return callback ? { kind: 'invoke', callback, args: [] } : { kind: 'value', value: selected }
    },
    { wasmBinary },
  )
  return {
    vm,
    calls,
    identities,
    aborted,
    lifecycle,
    faults,
    assertSettled() {
      assert.equal(open.size, 0)
      assert.deepEqual([...aborted].sort(), [...identities].sort())
    },
    answer(value: ScriptValue) {
      selected = value
    },
    release() {
      if (callback) vm.release(callback)
      callback = undefined
    },
    dispose() {
      vm.dispose()
    },
  }
}

async function execute(vm: TjsWasmRuntime, binary: boolean, source: string) {
  const program = `var Storages=__host("Factory");\n${source}`
  const input = binary ? await vm.compile(program, 'storage-selector-native.tjs') : program
  if (binary) {
    assert(input instanceof Uint8Array)
    assert.equal(new TextDecoder().decode(input.subarray(0, 4)), 'TJS2')
  }
  await vm.execute(input, binary ? 'storage-selector-native.cjs' : 'storage-selector-native.tjs')
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`selectFile is native, requires an object, and runs with discarded results (${mode})`, async () => {
    const fixture = await boundary('0\ngame://./chosen.sav')
    const { vm, calls } = fixture
    try {
      assert.equal(manifest.capabilities?.nativeStorages, 2)
      await execute(
        vm,
        binary,
        `
var identity=Storages.selectFile instanceof "Function",rejected=0,extra=0,intercepted=0;
try{Storages.selectFile();}catch(error){rejected++;}
try{var unused=Storages.selectFile();}catch(error){rejected++;}
var invalid=[void,null,1,"name",<% 01 %>];
for(var i=0;i<invalid.count;i++)try{Storages.selectFile(invalid[i]);}catch(error){rejected++;}
function argument(){extra++;return <% 01 %>;}
var options=%[],receiver=%[];
var borrowed=Storages.selectFile incontextof receiver;
global.__host=function(){intercepted++;throw new Exception("wrong host");};
borrowed(options,argument());
var answer=borrowed(options,argument());
var state=[answer,options.filterIndex,options.name,extra,intercepted].join("|");
`,
      )
      assert.equal(await vm.execute('identity', '', true), 1n)
      assert.equal(await vm.execute('rejected', '', true), 7n)
      assert.equal(await vm.execute('state', '', true), '1|0|game://./chosen.sav|2|0')
      assert.deepEqual(calls, [
        { operation: 'Storages.selectFile', args: defaults },
        { operation: 'Storages.selectFilePath', args: ['game://./chosen.sav'] },
        {
          operation: 'Storages.selectFile',
          args: [0n, 'game://./chosen.sav', '', undefined, 0n, undefined, 0n],
        },
      ])
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile distinguishes missing fields and uses native numeric and truth conversions (${mode})`, async () => {
    const fixture = await boundary()
    const { vm, calls } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var empty=%[],explicit=%[filter:void,filterIndex:4294967295,name:void,initialDir:void,
  title:void,save:"true",defaultExt:void];
var first=Storages.selectFile(empty),second=Storages.selectFile(explicit);
var wrapped=%[filter:%[count:-1],filterIndex:4294967298,save:%[]];
Storages.selectFile(wrapped);
var state=[first,second,empty.name===void,explicit.name===void,explicit.filterIndex].join("|");
`,
      )
      assert.equal(await vm.execute('state', '', true), '0|0|1|1|4294967295')
      assert.deepEqual(calls, [
        { operation: 'Storages.selectFile', args: defaults },
        { operation: 'Storages.selectFile', args: [4294967295n, '', '', '', 0n, '', 1n, ''] },
        { operation: 'Storages.selectFile', args: [2n, '', '', undefined, 1n, undefined, 1n] },
      ])
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile reads options once in order and writes them after a real TJS continuation (${mode})`, async () => {
    const fixture = await boundary('2\ngame://./selected/雪😀.sav')
    const { vm, calls } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var order=[],state=%[filterIndex:-1,name:"old.sav"];
function mark(name){global.order.add(name);__host("Trace",name);}
class Filters {
  property count {getter(){global.mark("count");return 3;}}
  property first {getter(){global.mark("item0");return "Saved|*.sav;*.dat";}}
  property last {getter(){global.mark("item2");return "All|*.*";}}
}
var filters=new Filters();&filters["0"]=&filters.first;&filters["2"]=&filters.last;
class Options {
  property filter {getter(){global.mark("filter");return global.filters;}}
  property filterIndex {
    getter(){global.mark("filterIndex");return global.state.filterIndex;}
    setter(value){global.mark("setIndex:"+value);global.state.filterIndex=value;}
  }
  property name {
    getter(){global.mark("name");return global.state.name;}
    setter(value){global.mark("setName:"+value);global.state.name=value;}
  }
  property initialDir {getter(){global.mark("initialDir");return "savedata/";}}
  property title {getter(){global.mark("title");return "選択 雪😀";}}
  property save {getter(){global.mark("save");return "1";}}
  property defaultExt {getter(){global.mark("defaultExt");return "sav";}}
  property multiple {getter(){throw new Exception("must not read multiple");}}
  property directory {getter(){throw new Exception("must not read directory");}}
}
function continued(){
  global.mark("continuation");
  if(global.state.name!=="old.sav")throw new Exception("premature writeback");
  return __host("Answer");
}
__host("Capture",continued);
var options=new Options(),answer=Storages.selectFile(options);
`,
      )
      assert.equal(await vm.execute('answer', '', true), 1n)
      assert.equal(
        await vm.execute('order.join("|")', '', true),
        'filter|count|item0|item2|filterIndex|name|initialDir|title|save|defaultExt|continuation|setIndex:2|setName:game://./selected/雪😀.sav',
      )
      assert.deepEqual(
        calls.filter((call) => call.operation !== 'Trace'),
        [
          { operation: 'Storages.selectFilePath', args: ['old.sav'] },
          { operation: 'Storages.selectFilePath', args: ['savedata/'] },
          {
            operation: 'Storages.selectFile',
            args: [
              4294967295n,
              'game://./old.sav',
              'game://./savedata/',
              '選択 雪😀',
              1n,
              'sav',
              1n,
              'Saved|*.sav;*.dat',
              'All|*.*',
            ],
          },
          { operation: 'Answer', args: [] },
        ],
      )
      assert.equal(
        calls.findIndex((call) => call.operation === 'Storages.selectFilePath'),
        6,
      )
      fixture.release()
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile stops at getter, conversion and path failures before later fields (${mode})`, async () => {
    const fixture = await boundary()
    const { vm, calls } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var order=[],phase=0,errors=[];
class Options {
  property filter {getter(){global.order.add("filter");if(global.phase===0)throw new Exception("filter failed");return global.phase===1 ? <% 01 %> : "All|*.*";}}
  property filterIndex {getter(){global.order.add("index");return global.phase===2 ? <% 01 %> : 0;}}
  property name {getter(){global.order.add("name");return global.phase===3 ? "reject-path" : "";}}
  property initialDir {getter(){global.order.add("directory");throw new Exception("directory failed");}}
  property title {getter(){global.order.add("title");return "unexpected";}}
}
var options=new Options();
for(phase=0;phase<5;phase++){
  try{Storages.selectFile(options);errors.add("unexpected");}catch(error){errors.add(error.message);}
}
var recovery=Storages.selectFile(%[]);
`,
      )
      assert.equal(
        await vm.execute('order.join("|")', '', true),
        'filter|filter|filter|index|filter|index|name|filter|index|name|directory',
      )
      assert.equal(await vm.execute('errors[0]', '', true), 'filter failed')
      assert.match(String(await vm.execute('errors[3]', '', true)), /selector-path-rejected/)
      assert.equal(await vm.execute('errors[4]', '', true), 'directory failed')
      assert.equal(await vm.execute('recovery', '', true), 0n)
      assert.deepEqual(calls, [
        { operation: 'Storages.selectFilePath', args: ['reject-path'] },
        { operation: 'Storages.selectFile', args: defaults },
      ])
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile uses each option and filter object's own receiver instead of its bound closure (${mode})`, async () => {
    const fixture = await boundary('1\ngame://./selected.sav')
    const { vm, calls } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var trace=[],fake=%[marker:"wrong"];
class Filters {
  property count {getter(){global.trace.add(this.marker+":count");return 1;}}
  property entry {getter(){global.trace.add(this.marker+":entry");return "All|*.*";}}
}
var filters=new Filters();filters.marker="filters";&filters["0"]=&filters.entry;
var boundFilters=filters incontextof fake;
class Options {
  property filter {getter(){global.trace.add(this.marker+":filter");return global.boundFilters;}}
  property filterIndex {
    getter(){global.trace.add(this.marker+":index");return 1;}
    setter(value){global.trace.add(this.marker+":setIndex");}
  }
  property name {
    getter(){global.trace.add(this.marker+":name");return "";}
    setter(value){global.trace.add(this.marker+":setName");}
  }
}
var options=new Options();options.marker="options";
var boundOptions=options incontextof fake,answer=Storages.selectFile(boundOptions);
`,
      )
      assert.equal(await vm.execute('answer', '', true), 1n)
      assert.equal(
        await vm.execute('trace.join("|")', '', true),
        'options:filter|filters:count|filters:entry|options:index|options:name|options:setIndex|options:setName',
      )
      assert.deepEqual(calls, [
        {
          operation: 'Storages.selectFile',
          args: [1n, '', '', undefined, 0n, undefined, 1n, 'All|*.*'],
        },
      ])
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile retains count snapshot, converts each sparse item immediately and never stringifies JS-style (${mode})`, async () => {
    const fixture = await boundary()
    const { vm, calls } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var reads=[],countReads=0,custom=0,phase=0;
class Filters {
  property count {getter(){global.countReads++;return 3;}}
  property first {getter(){global.reads.add(0);this["1"]="replacement";this["3"]="tail";return global.phase===0 ? <% 01 %> : 7;}}
  property last {getter(){global.reads.add(2);return "Last|*.dat";}}
}
var filters=new Filters();&filters["0"]=&filters.first;&filters["2"]=&filters.last;
try{Storages.selectFile(%[filter:filters]);}catch(error){}
phase=1;Storages.selectFile(%[filter:filters]);
var value=%[toString:function(){global.custom++;return "wrong";}];
var expected=string(value),sparse=%[count:1];sparse["0"]=value;
Storages.selectFile(%[filter:sparse]);
`,
      )
      assert.equal(await vm.execute('reads.join("|")', '', true), '0|0|2')
      assert.equal(await vm.execute('countReads', '', true), 2n)
      assert.equal(await vm.execute('custom', '', true), 0n)
      const expected = await vm.execute('expected', '', true)
      assert.deepEqual(calls, [
        {
          operation: 'Storages.selectFile',
          args: [0n, '', '', undefined, 0n, undefined, 1n, '7', 'replacement', 'Last|*.dat'],
        },
        {
          operation: 'Storages.selectFile',
          args: [0n, '', '', undefined, 0n, undefined, 1n, expected],
        },
      ])
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile cancellation leaves options untouched and ignores returned property failure statuses (${mode})`, async () => {
    const fixture = await boundary()
    const { vm, calls } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var writes=0;
class Options {
  property filterIndex {getter(){return 3;}setter(value){global.writes++;}}
  property name {getter(){return "old.sav";}setter(value){global.writes++;}}
}
var options=new Options(),cancelled=Storages.selectFile(options);
class ReadOnly {
  property filterIndex {getter(){return 4;}}
  property name {getter(){return "unchanged.sav";}}
}
var readOnly=new ReadOnly(),dead=%[];invalidate dead;
`,
      )
      assert.equal(await vm.execute('[cancelled,writes].join("|")', '', true), '0|0')
      fixture.answer('1\ngame://./chosen.sav')
      await vm.execute(
        'var accepted=Storages.selectFile(readOnly),invalidAccepted=Storages.selectFile(dead);',
      )
      assert.equal(
        await vm.execute(
          '[accepted,readOnly.filterIndex,readOnly.name,invalidAccepted,isvalid dead].join("|")',
          '',
          true,
        ),
        '1|4|unchanged.sav|1|0',
      )
      assert.equal(calls.filter((call) => call.operation === 'Storages.selectFile').length, 3)
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile success writes index before name and keeps partial writes after setter exceptions (${mode})`, async () => {
    const fixture = await boundary('4294967295\ngame://./selected.sav')
    const { vm } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var phase=0,writes=[],stored=7,errors=[];
class Options {
  property filterIndex {
    getter(){return global.stored;}
    setter(value){global.writes.add("index:"+value);if(global.phase===0)throw new Exception("index setter failed");global.stored=value;}
  }
  property name {
    getter(){return "";}
    setter(value){global.writes.add("name:"+value);throw new Exception("name setter failed");}
  }
}
var options=new Options();
for(phase=0;phase<2;phase++)try{Storages.selectFile(options);}catch(error){errors.add(error.message);}
var accepted=Storages.selectFile(%[]);
`,
      )
      assert.equal(
        await vm.execute('errors.join("|")', '', true),
        'index setter failed|name setter failed',
      )
      assert.equal(
        await vm.execute('writes.join("|")', '', true),
        'index:-1|index:-1|name:game://./selected.sav',
      )
      assert.equal(await vm.execute('[stored,accepted].join("|")', '', true), '-1|1')
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile applies explicit bounded Web inputs without reading later getters (${mode})`, async () => {
    const fixture = await boundary()
    const { vm, calls } = fixture
    try {
      await execute(
        vm,
        binary,
        `
function repeat(value,count){var output="";while(count>0){if(count&1)output+=value;count>>=1;if(count>0)value+=value;}return output;}
var later=0,errors=[],phase=0;
class Options {
  property filter {getter(){
    if(global.phase===0)return null;
    if(global.phase===1)return %[count:257];
    if(global.phase===2)return global.repeat("x",262145);
    return "All|*.*";
  }}
  property name {getter(){if(global.phase===3)return global.repeat("x",4097);return "";}}
  property title {getter(){if(global.phase===4)return global.repeat("x",4097);global.later++;return "";}}
  property defaultExt {getter(){if(global.phase===5)return global.repeat("x",4097);return "";}}
}
for(phase=0;phase<6;phase++)try{Storages.selectFile(new Options());}catch(error){errors.add(error.message);}
var accepted=Storages.selectFile(%[filter:repeat("x",262144)]);
`,
      )
      assert.equal(await vm.execute('errors.count', '', true), 6n)
      assert.match(String(await vm.execute('errors[0]', '', true)), /non-null filter object/)
      assert.match(String(await vm.execute('errors[1]', '', true)), /filter count exceeds 256/)
      assert.equal(await vm.execute('later', '', true), 1n)
      assert.equal(await vm.execute('accepted', '', true), 0n)
      assert.equal(calls.length, 1)
      assert.equal((calls[0]!.args[7] as string).length, 262144)
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile rejects malformed host completion before options writeback (${mode})`, async () => {
    const fixture = await boundary()
    const { vm } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var writes=0,options=%[];
class Writer {
  property filterIndex {getter(){return 0;}setter(value){global.writes++;}}
  property name {getter(){return "";}setter(value){global.writes++;}}
}
options=new Writer();
function attempt(){try{Storages.selectFile(global.options);return "accepted";}catch(error){return error.message;}}
`,
      )
      for (const invalid of [
        null,
        1n,
        '',
        '1',
        '-1\ngame://./a',
        '4294967296\ngame://./a',
        '00000000001\na',
        '1\n',
        `1\n${'x'.repeat(4097)}`,
      ]) {
        fixture.answer(invalid)
        assert.match(
          String(await vm.execute('attempt()', '', true)),
          /invalid (response|filter index)/,
        )
      }
      assert.equal(await vm.execute('writes', '', true), 0n)
      fixture.answer('1\ngame://./valid.sav')
      assert.equal(await vm.execute('attempt()', '', true), 'accepted')
      assert.equal(await vm.execute('writes', '', true), 2n)
      fixture.assertSettled()
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile identities span native class replacement and cleanup precedes successful setters (${mode})`, async () => {
    const fixture = await boundary()
    const { vm } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var cancelled=Storages.selectFile(%[]),getterError="";
class Bad {property filter {getter(){throw new Exception("before opening");}}}
try{Storages.selectFile(new Bad());}catch(error){getterError=error.message;}
Storages=__host("Factory");
var second=Storages.selectFile(%[]),writes=0;
class Options {
  property filterIndex {getter(){return 0;}setter(value){global.writes++;__host("Trace","setIndex");}}
  property name {getter(){return "";}setter(value){global.writes++;__host("Trace","setName");}}
}
var options=new Options();
`,
      )
      assert.equal(
        await vm.execute('[cancelled,second,getterError].join("|")', '', true),
        '0|0|before opening',
      )
      assert.deepEqual(fixture.identities, [1n, 2n])
      fixture.answer('1\ngame://./chosen.sav')
      await vm.execute('var accepted=Storages.selectFile(options);')
      assert.equal(await vm.execute('[accepted,writes].join("|")', '', true), '1|2')
      assert.deepEqual(fixture.identities, [1n, 2n, 3n])
      assert.deepEqual(fixture.lifecycle, [
        'select:1',
        'abort:1',
        'select:2',
        'abort:2',
        'select:3',
        'abort:3',
        'trace:setIndex',
        'trace:setName',
      ])
      fixture.assertSettled()
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile abort preserves dispatch and continuation errors even when cleanup fails (${mode})`, async () => {
    const fixture = await boundary()
    const { vm } = fixture
    try {
      await execute(
        vm,
        binary,
        `
function attempt(){try{Storages.selectFile(%[]);return "accepted";}catch(error){return error.message;}}
function continuation(){throw new Exception("continuation-primary");}
`,
      )
      fixture.faults.selection = 'dispatch-primary'
      assert.match(String(await vm.execute('attempt()', '', true)), /dispatch-primary/)
      delete fixture.faults.selection
      await vm.execute('__host("Capture",continuation);')
      fixture.faults.abort = 'cleanup-secondary'
      assert.equal(await vm.execute('attempt()', '', true), 'continuation-primary')
      delete fixture.faults.abort
      fixture.release()
      await vm.collect()
      assert.equal(await vm.execute('attempt()', '', true), 'accepted')
      assert.deepEqual(fixture.identities, [1n, 2n, 3n])
      assert.deepEqual(fixture.aborted, [1n, 2n, 3n])
      fixture.assertSettled()
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      fixture.dispose()
    }
  })

  test(`selectFile cleanup failure prevents writeback and never executes an abort continuation (${mode})`, async () => {
    const fixture = await boundary('1\ngame://./chosen.sav')
    const { vm } = fixture
    try {
      await execute(
        vm,
        binary,
        `
var writes=0,continued=0;
class Options {
  property filterIndex {getter(){return 0;}setter(value){global.writes++;}}
  property name {getter(){return "";}setter(value){global.writes++;}}
}
var options=new Options();
function attempt(){try{Storages.selectFile(global.options);return "accepted";}catch(error){return error.message;}}
function continuation(){global.continued++;return __host("Answer");}
`,
      )
      fixture.faults.abort = 'cleanup-primary'
      assert.match(String(await vm.execute('attempt()', '', true)), /cleanup-primary/)
      assert.equal(await vm.execute('writes', '', true), 0n)
      delete fixture.faults.abort
      fixture.faults.invokeAbort = true
      await vm.execute('__host("Capture",continuation);')
      assert.match(
        String(await vm.execute('attempt()', '', true)),
        /abort host returned an invalid response/,
      )
      assert.equal(await vm.execute('[writes,continued].join("|")', '', true), '0|1')
      delete fixture.faults.invokeAbort
      fixture.release()
      await vm.collect()
      assert.equal(await vm.execute('attempt()', '', true), 'accepted')
      assert.equal(await vm.execute('[writes,continued].join("|")', '', true), '2|1')
      assert.deepEqual(fixture.aborted, [1n, 2n, 3n])
      fixture.assertSettled()
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
    } finally {
      fixture.dispose()
    }
  })
}
