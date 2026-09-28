import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  isScriptObject,
  type ScriptClass,
  type ScriptValue,
} from '../../src/engine/script/runtime.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
const phaseVocoderClass: ScriptClass = {
  type: 'class',
  namespace: 'PhaseVocoder',
  id: 0,
  className: 'PhaseVocoder',
  properties: [],
}
const properties = ['interface', 'window', 'overlap', 'pitch', 'time'] as const

async function program(vm: TjsWasmRuntime, binary: boolean, source: string) {
  return binary ? vm.compile(source, 'native-phase-vocoder-factory.tjs') : source
}

/** Records only the native boundary; it does not implement SoundService or DSP.
 * The real native class must convert values and reject forged receivers before
 * reaching this handler. Weak observation deliberately adds no native lifetime
 * metadata from which the PhaseVocoder identity lookup could infer its answer. */
async function boundary() {
  const live = new Map<number, Record<string, ScriptValue>>()
  const retired: number[] = []
  const writes: { id: number; property: string; value: ScriptValue }[] = []
  let constructions = 0
  const vm: TjsWasmRuntime = await TjsWasmRuntime.create(
    factory,
    (operation, args) => {
      if (operation === 'Factory') return { kind: 'value', value: phaseVocoderClass }
      if (operation === 'PhaseVocoder.construct') {
        assert.equal(args.length, 1, 'Only the actual native receiver crosses the boundary')
        assert(isScriptObject(args[0]))
        assert.equal(vm.nativePhaseVocoderIdentifier(args[0]), 0)
        assert.equal(
          vm.nativeLifetimeIdentifier(args[0], 'PhaseVocoder.nativeInvalidate'),
          undefined,
        )
        const id = ++constructions
        live.set(id, { window: 4096n, overlap: 0n, pitch: 1, time: 1 })
        vm.observe(args[0], () => {
          retired.push(id)
          live.delete(id)
        })
        return { kind: 'value', value: BigInt(id) }
      }
      if (operation === 'Identity') {
        assert.equal(args.length, 1)
        assert(isScriptObject(args[0]))
        const id = vm.nativePhaseVocoderIdentifier(args[0])
        return { kind: 'value', value: id === undefined ? undefined : BigInt(id) }
      }
      if (operation === 'Bind') {
        assert.equal(args.length, 1)
        assert(isScriptObject(args[0]))
        vm.bindPhaseVocoderClass(args[0])
        return { kind: 'value', value: undefined }
      }
      assert(operation === 'PhaseVocoder.get' || operation === 'PhaseVocoder.set')
      assert.equal(args.length, operation === 'PhaseVocoder.get' ? 2 : 3)
      assert.equal(typeof args[0], 'bigint')
      assert.equal(typeof args[1], 'string')
      const id = Number(args[0]),
        property = args[1] as string,
        state = live.get(id)
      assert(state, 'No retired or forged identifier may reach the host')
      assert(properties.includes(property as (typeof properties)[number]))
      assert.notEqual(property, 'interface', 'The opaque interface is resolved by the native slot')
      if (operation === 'PhaseVocoder.get') return { kind: 'value', value: state[property] }
      state[property] = args[2]
      writes.push({ id, property, value: args[2] })
      return { kind: 'value', value: undefined }
    },
    { wasmBinary },
  )
  return { vm, live, retired, writes }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(
    `native PhaseVocoder has fixed members, receiver identity and a read-only opaque interface (${mode})`,
    { timeout: 60000 },
    async () => {
      const { vm, live, retired, writes } = await boundary()
      try {
        assert.equal(manifest.capabilities?.nativePhaseVocoder, 1)
        await vm.execute(
          await program(
            vm,
            binary,
            `
var PhaseVocoder=__host("Factory"),p=new PhaseVocoder("ignored",void,<% 01 %>);
class Child extends PhaseVocoder {function Child(){super.PhaseVocoder(%[owner:"ignored"]);}}
var child=new Child();
var identity=[PhaseVocoder instanceof "Class",p instanceof "PhaseVocoder",
  child instanceof "PhaseVocoder",child instanceof "Child",
  p.PhaseVocoder instanceof "Function",p.finalize instanceof "Function"].join("|");
var nativeProperties=[${properties.map((name) => `(&p.${name}) instanceof "Property"`).join(',')}].join("|");
var ids=[p.interface,child.interface,__host("Identity",p),__host("Identity",child)].join("|");
var readOnly=0,repeated=0,forged=0;
try{p.interface=child.interface;}catch(error){readOnly++;}
try{child.PhaseVocoder();}catch(error){repeated++;}
var fake=%[__phaseVocoderId:1,__id:1,interface:1],names=${JSON.stringify(properties)};
for(var i=0;i<names.count;i++){
  var bad=(&p[names[i]]) incontextof fake;
  try{var ignored=*bad;}catch(error){forged++;}
  try{*bad=1;}catch(error){forged++;}
}
var badConstructor=p.PhaseVocoder incontextof fake;
try{badConstructor();}catch(error){forged++;}
class Spoof {property interface {getter(){throw new Exception("must not read interface");}}}
var spoof=new Spoof(),fakeIdentity=__host("Identity",fake),spoofIdentity=__host("Identity",spoof);
p.__phaseVocoderId=2;p.__id=2;
var rebound=(&p.pitch) incontextof child;*(&global.rebound)=1.5;
var preserved=[p.interface,child.interface,p.pitch,child.pitch].join("|");
p.finalize();child.finalize();
var stillLive=[__host("Identity",p),__host("Identity",child)].join("|");
invalidate p;invalidate child;
var deadIdentities=[__host("Identity",p)===void,__host("Identity",child)===void].join("|");
`,
          ),
        )
        assert.equal(await vm.execute('identity', '', true), '1|1|1|1|1|1')
        assert.equal(await vm.execute('nativeProperties', '', true), '1|1|1|1|1')
        assert.equal(await vm.execute('ids', '', true), '1|2|1|2')
        assert.equal(await vm.execute('[readOnly,repeated,forged].join("|")', '', true), '1|1|11')
        assert.equal(await vm.execute('fakeIdentity===void && spoofIdentity===void', '', true), 1n)
        assert.equal(await vm.execute('preserved', '', true), '1|2|1|1.5')
        assert.equal(await vm.execute('stillLive', '', true), '1|2')
        assert.equal(await vm.execute('deadIdentities', '', true), '1|1')
        assert.deepEqual(writes, [{ id: 2, property: 'pitch', value: 1.5 }])
        assert.deepEqual(retired, [1, 2])
        assert.equal(live.size, 0)
        await vm.collect()
        assert.equal(vm.inspect().handles, 0)
        assert.equal(vm.inspect().weakOwners, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  test(
    `native PhaseVocoder narrows integer and float32 setters before the host boundary (${mode})`,
    { timeout: 60000 },
    async () => {
      const { vm, writes } = await boundary()
      try {
        await vm.execute(
          await program(
            vm,
            binary,
            `
var PhaseVocoder=__host("Factory"),p=new PhaseVocoder();
p.window=4294967360;p.overlap=4294967298;p.window=9007199254741056;
p.overlap=-4294967294;p.window="128.9";p.overlap=8.75;
p.pitch=1.0594630943593;p.time=1.0000000596046448;
p.pitch="0.123456789";p.time=9007199254740993;
var rejected=0,unchanged=0,names=["window","overlap","pitch","time"],values=[%[],null,<% 01 %>];
for(var i=0;i<names.count;i++){
  var before=p[names[i]];
  for(var j=0;j<values.count;j++){
    try{p[names[i]]=values[j];}catch(error){rejected++;}
    if(p[names[i]]===before)unchanged++;
  }
}
`,
          ),
        )
        assert.deepEqual(writes, [
          { id: 1, property: 'window', value: 64n },
          { id: 1, property: 'overlap', value: 2n },
          { id: 1, property: 'window', value: 64n },
          { id: 1, property: 'overlap', value: 2n },
          { id: 1, property: 'window', value: 128n },
          { id: 1, property: 'overlap', value: 8n },
          { id: 1, property: 'pitch', value: Math.fround(1.0594630943593) },
          { id: 1, property: 'time', value: Math.fround(1.0000000596046448) },
          { id: 1, property: 'pitch', value: Math.fround(0.123456789) },
          { id: 1, property: 'time', value: Math.fround(9007199254740992) },
        ])
        assert.equal(await vm.execute('[rejected,unchanged].join("|")', '', true), '12|12')
        assert.equal(await vm.execute('p.pitch', '', true), Math.fround(0.123456789))
        assert.equal(await vm.execute('p.time', '', true), Math.fround(9007199254740992))
        await vm.execute('invalidate p;')
        await vm.collect()
        assert.equal(vm.inspect().handles, 0)
        assert.equal(vm.inspect().weakOwners, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  test(
    `native PhaseVocoder finalizer failure keeps identity until retry and weak observation never retains it (${mode})`,
    { timeout: 60000 },
    async () => {
      const { vm, live, retired } = await boundary()
      try {
        await vm.execute(
          await program(
            vm,
            binary,
            `
var PhaseVocoder=__host("Factory"),retry=false,trace=[];
class Filter extends PhaseVocoder {
  function Filter(){super.PhaseVocoder();}
  function finalize(){
    global.trace.add([this.interface,__host("Identity",this),this.pitch,isvalid this].join(":"));
    this.pitch=1.5;
    if(!global.retry)throw new global.Exception("filter-finalizer-failed");
  }
}
var filter=new Filter();
function attempt(){try{invalidate global.filter;return "retired";}catch(error){return error.message;}}
function allowRetry(){global.retry=true;return global.attempt();}
function temporary(){var value=new Filter();return 7;}
`,
          ),
        )
        assert.equal(await vm.execute('attempt()', '', true), 'filter-finalizer-failed')
        assert.equal(
          await vm.execute(
            '[isvalid filter,filter.pitch,__host("Identity",filter)].join("|")',
            '',
            true,
          ),
          '1|1.5|1',
        )
        assert.deepEqual(retired, [])
        assert.equal(live.size, 1)
        assert.equal(vm.inspect().weakOwners, 1)
        assert.equal(await vm.execute('allowRetry()', '', true), 'retired')
        assert.equal(await vm.execute('trace.join("|")', '', true), '1:1:1:1|1:1:1.5:1')
        assert.equal(await vm.execute('__host("Identity",filter)===void', '', true), 1n)
        assert.deepEqual(retired, [1])
        assert.equal(live.size, 0)
        assert.equal(await vm.execute('temporary()', '', true), 7n)
        await vm.collect()
        assert.deepEqual(retired, [1, 2])
        assert.equal(live.size, 0)
        assert.equal(await vm.execute('trace[2]', '', true), '2:2:1:1')
        assert.equal(vm.inspect().handles, 0)
        assert.equal(vm.inspect().weakOwners, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  test(
    `native PhaseVocoder snapshot propagates a getter exception once and rejects forged interfaces (${mode})`,
    { timeout: 60000 },
    async () => {
      const { vm } = await boundary()
      try {
        await vm.execute(
          await program(
            vm,
            binary,
            `
class Wave {}
__host("Bind",Wave);
var PhaseVocoder=__host("Factory"),firstReads=0,laterReads=0;
class Throwing {
  property interface {getter(){global.firstReads++;throw new global.Exception("interface-getter-failed");}}
}
class Later {
  property interface {getter(){global.laterReads++;return 1;}}
}
function snapshotError(value){
  try{global.Wave.__snapshotPhaseVocoderFilters(value);return "accepted";}
  catch(error){return error.message;}
}
var failure=snapshotError([new Throwing(),new Later()]);
var dead=new PhaseVocoder(),good=new Wave.PhaseVocoder();invalidate dead;
var selected=Wave.__snapshotPhaseVocoderFilters([%[],dead,good]);
var selectedIdentity=[selected.count,selected[0]===good,__host("Identity",selected[0])].join("|");
var forged=snapshotError([%[interface:good.interface,__phaseVocoderId:good.interface]]);
var notArray=snapshotError(%[count:0]),over=[];over.count=17;
var overBudget=snapshotError(over);
var staticMembers=[Wave.PhaseVocoder instanceof "Class",
  Wave.__snapshotPhaseVocoderFilters instanceof "Function"].join("|");
invalidate good;
`,
          ),
        )
        assert.equal(await vm.execute('failure', '', true), 'interface-getter-failed')
        assert.equal(await vm.execute('[firstReads,laterReads].join("|")', '', true), '1|0')
        assert.equal(await vm.execute('selectedIdentity', '', true), '1|1|2')
        assert.match(
          String(await vm.execute('forged', '', true)),
          /filters require live native PhaseVocoder instances/,
        )
        assert.match(String(await vm.execute('notArray', '', true)), /filters must be an Array/)
        assert.match(
          String(await vm.execute('overBudget', '', true)),
          /filter snapshot budget exceeded/,
        )
        assert.equal(await vm.execute('staticMembers', '', true), '1|1')
        await vm.collect()
        assert.equal(vm.inspect().handles, 0)
        assert.equal(vm.inspect().weakOwners, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  test(
    `native PhaseVocoder snapshot reads count once and visits the current item in initial index order (${mode})`,
    { timeout: 60000 },
    async () => {
      const { vm } = await boundary()
      try {
        await vm.execute(
          await program(
            vm,
            binary,
            `
class Wave {}
__host("Bind",Wave);
var PhaseVocoder=__host("Factory"),readOrder=[],countReads=0;
var a=new PhaseVocoder(),b=new PhaseVocoder(),replacement=new PhaseVocoder(),tail=new PhaseVocoder();
var filters=[a,b];
class CountReader {
  property count {getter(){global.countReads++;return 2;}}
}
class InterfaceReader {
  property interface {
    getter(){
      global.readOrder.add(this.marker);
      if(this.marker==="a"){
        global.filters[1]=global.replacement;
        global.filters.add(global.tail);
      }
      return this.originalToken;
    }
  }
}
var countReader=new CountReader(),interfaceReader=new InterfaceReader(),all=[a,b,replacement,tail];
var markers=["a","b","replacement","tail"];
for(var i=0;i<all.count;i++){
  var filter=all[i];filter.originalToken=filter.interface;filter.marker=markers[i];
  &filter.interface=(&interfaceReader.interface) incontextof filter;
}
&filters.count=&countReader.count;
var selected=Wave.__snapshotPhaseVocoderFilters(filters);
var selectedIdentity=[selected.count,selected[0]===a,selected[1]===replacement,
  __host("Identity",selected[0]),__host("Identity",selected[1])].join("|");
var appended=filters[2]===tail;
invalidate a;invalidate b;invalidate replacement;invalidate tail;
`,
          ),
        )
        assert.equal(await vm.execute('countReads', '', true), 1n)
        assert.equal(await vm.execute('readOrder.join("|")', '', true), 'a|replacement')
        assert.equal(await vm.execute('selectedIdentity', '', true), '2|1|1|1|3')
        assert.equal(await vm.execute('appended', '', true), 1n)
        await vm.collect()
        assert.equal(vm.inspect().handles, 0)
        assert.equal(vm.inspect().weakOwners, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  test(
    `native PhaseVocoder rejects malformed factory metadata and recovers (${mode})`,
    { timeout: 60000 },
    async () => {
      let reply: ScriptValue = phaseVocoderClass
      const vm = await TjsWasmRuntime.create(
        factory,
        (operation) => {
          assert.equal(operation, 'Factory')
          return { kind: 'value', value: reply }
        },
        { wasmBinary },
      )
      const cases: { value: ScriptValue; error: RegExp }[] = [
        {
          value: { ...phaseVocoderClass, namespace: 'PhaseVocoder\0suffix' },
          error: /Invalid native class identity/,
        },
        {
          value: { ...phaseVocoderClass, className: 'PhaseVocoder\0suffix' },
          error: /Invalid native class identity/,
        },
        { value: { ...phaseVocoderClass, id: 1 }, error: /Invalid PhaseVocoder class factory/ },
        {
          value: { ...phaseVocoderClass, className: 'Other' },
          error: /Invalid PhaseVocoder class factory/,
        },
        {
          value: {
            ...phaseVocoderClass,
            properties: [{ name: 'pitch', writable: true, static: false, boolean: false }],
          },
          error: /Invalid PhaseVocoder class factory/,
        },
        {
          value: { ...phaseVocoderClass, systemMethods: [] },
          error: /Invalid PhaseVocoder class factory/,
        },
        {
          value: { ...phaseVocoderClass, systemProperties: [] },
          error: /Invalid PhaseVocoder class factory/,
        },
      ]
      try {
        const factoryCall = await program(vm, binary, 'var PhaseVocoder=__host("Factory");')
        for (const entry of cases) {
          reply = entry.value
          await assert.rejects(vm.execute(factoryCall), entry.error)
        }
        reply = phaseVocoderClass
        await vm.execute(factoryCall)
        assert.equal(await vm.execute('PhaseVocoder instanceof "Class"', '', true), 1n)
        await vm.collect()
        assert.equal(vm.inspect().handles, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  for (const version of [undefined, 0, 2])
    test(
      `native PhaseVocoder rejects a ${version === undefined ? 'missing' : `version ${version}`} capability export and recovers (${mode})`,
      { timeout: 60000 },
      async () => {
        // This mutates only the current kernel export to exercise its guard;
        // it is not evidence that an old kernel executed the new native class.
        let restore!: () => void
        const altered: ModuleFactory = async (options) => {
          const module = await factory(options),
            original = module._krkr_native_phase_vocoder_version!
          assert.equal(original(), 1)
          if (version === undefined)
            assert(Reflect.deleteProperty(module, '_krkr_native_phase_vocoder_version'))
          else module._krkr_native_phase_vocoder_version = () => version
          restore = () => {
            module._krkr_native_phase_vocoder_version = original
          }
          return module
        }
        const vm = await TjsWasmRuntime.create(
          altered,
          (operation) => {
            assert.equal(operation, 'Factory')
            return { kind: 'value', value: phaseVocoderClass }
          },
          { wasmBinary },
        )
        try {
          const factoryCall = await program(vm, binary, 'var PhaseVocoder=__host("Factory");')
          await assert.rejects(
            vm.execute(factoryCall),
            /TJS WASM is missing native PhaseVocoder support/,
          )
          restore()
          await vm.execute(factoryCall)
          assert.equal(await vm.execute('PhaseVocoder instanceof "Class"', '', true), 1n)
          await vm.collect()
          assert.equal(vm.inspect().handles, 0)
        } finally {
          vm.dispose()
        }
      },
    )
}
