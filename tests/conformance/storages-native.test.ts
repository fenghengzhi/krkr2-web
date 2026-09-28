import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

const methods = [
  'addAutoPath',
  'removeAutoPath',
  'getFullPath',
  'getPlacedPath',
  'isExistentStorage',
  'extractStorageExt',
  'extractStorageName',
  'extractStoragePath',
  'chopStorageExt',
] as const
const methodList = JSON.stringify(methods)
const operation = (method: string) =>
  method === 'isExistentStorage' ? 'Storages.exists' : `Storages.${method}`

// The real VM supplies all native identity, argument conversion, expression
// result and receiver behavior. This intentionally small host only observes
// the native boundary; resolver/path algorithms have separate session tests.
async function fixture(binary: boolean, source: string) {
  const calls: { operation: string; path: string }[] = []
  const vm = await TjsWasmRuntime.create(
    factory,
    (name, args) => {
      if (name === 'Storages.class')
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
      assert(
        methods.some((method) => operation(method) === name),
        name,
      )
      assert.equal(args.length, 1, 'Native methods forward exactly the converted first argument')
      assert.equal(typeof args[0], 'string', 'The native TJS boundary must convert before JS')
      const path = args[0] as string
      calls.push({ operation: name, path })
      if (path === 'host-reject') throw new Error('storage-native-host-failure')
      // A non-void reply also proves that add/remove discard any host payload.
      return { kind: 'value', value: path }
    },
    { wasmBinary },
  )
  try {
    const program = `var Storages=__host("Storages.class");\n${source}`
    const input = binary ? await vm.compile(program, 'storages-native.tjs') : program
    if (binary) {
      assert(input instanceof Uint8Array)
      assert.equal(new TextDecoder().decode(input.subarray(0, 4)), 'TJS2')
    }
    await vm.execute(input, binary ? 'storages-native.cjs' : 'storages-native.tjs')
    return { vm, calls }
  } catch (error) {
    vm.dispose()
    throw error
  }
}

test('native Storages capability coexists with native System version 2 and Clipboard support', async () => {
  assert.equal(manifest.abi, 5)
  assert.equal(manifest.capabilities?.nativeStorages, 1)
  assert.equal(manifest.capabilities?.nativeSystem, 2)
  assert.equal(manifest.capabilities?.nativeClipboard, 1)
})

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`Storages has nine native static methods and no constructor or public directory property (${mode})`, async () => {
    const { vm, calls } = await fixture(
      binary,
      `
var identity=[Storages instanceof "Class",Storages instanceof "Storages",
  Storages instanceof "Object",Storages instanceof "Dictionary",
  Storages instanceof "Function",typeof Storages.Storages,
  typeof Storages.currentDirectory,Storages.finalize instanceof "Function"].join("|");
var names=${methodList},nativeMethods=0;
for(var i=0;i<names.count;i++)if(Storages[names[i]] instanceof "Function")nativeMethods++;
var rejected=0,derivedConstructorCalls=0;
try{var direct=new Storages();}catch(error){rejected++;}
class DerivedStorages extends Storages {
  function DerivedStorages(){derivedConstructorCalls++;}
}
try{var derived=new DerivedStorages();}catch(error){rejected++;}
var empty=Storages.finalize("ignored",<% 01 %>,void);
var stillUsable=Storages.extractStorageName("after-construction");
`,
    )
    try {
      assert.equal(await vm.execute('identity', '', true), '1|1|1|0|0|undefined|undefined|1')
      assert.equal(await vm.execute('nativeMethods', '', true), 9n)
      assert.equal(await vm.execute('rejected', '', true), 2n)
      assert.equal(await vm.execute('derivedConstructorCalls', '', true), 0n)
      assert.equal(await vm.execute('empty===void', '', true), 1n)
      assert.equal(await vm.execute('stillUsable', '', true), 'after-construction')
      assert.deepEqual(calls, [
        { operation: 'Storages.extractStorageName', path: 'after-construction' },
      ])
    } finally {
      vm.dispose()
    }
  })

  test(`every Storages method rejects missing arguments for both used and unused results (${mode})`, async () => {
    const { vm, calls } = await fixture(
      binary,
      `
var names=${methodList},missing=0;
for(var i=0;i<names.count;i++){
  try{Storages[names[i]]();}catch(error){missing++;}
  try{var answer=Storages[names[i]]();}catch(error){missing++;}
}
`,
    )
    try {
      assert.equal(await vm.execute('missing', '', true), 18n)
      assert.deepEqual(calls, [])
    } finally {
      vm.dispose()
    }
  })

  test(`Storages uses TJS string conversion before crossing the host boundary (${mode})`, async () => {
    const { vm, calls } = await fixture(
      binary,
      `
var replaced=0,customStringified=0,extraEvaluated=0;
function extra(){extraEvaluated++;return <% 01 %>;}
var object=%[replace:function(){replaced++;return "wrong";},
  toString:function(){customStringified++;return "wrong";}];
var values=[void,9007199254740993,0.0,1.25,null,object,"雪 🌸/Name.TXT"],
  names=${methodList},expected=[],resultMismatch=0;
for(var i=0;i<names.count;i++)for(var j=0;j<values.count;j++){
  var path=string(values[j]);expected.add(path);
  var answer=Storages[names[i]](values[j],extra());
  if(i<2 ? answer!==void : answer!==path)resultMismatch++;
}
`,
    )
    try {
      assert.equal(await vm.execute('replaced', '', true), 0n)
      assert.equal(await vm.execute('customStringified', '', true), 0n)
      assert.equal(await vm.execute('extraEvaluated', '', true), 63n)
      assert.equal(await vm.execute('resultMismatch', '', true), 0n)
      assert.equal(
        await vm.execute('expected.join("\\n")', '', true),
        calls.map((c) => c.path).join('\n'),
      )
      assert.deepEqual(
        calls.map((c) => c.operation),
        methods.flatMap((method) => Array<string>(7).fill(operation(method))),
      )
      assert.equal(calls[0]!.path, '')
      assert.equal(calls[1]!.path, '9007199254740993')
    } finally {
      vm.dispose()
    }
  })

  test(`Storages stringifies octets before the unused-result shortcut (${mode})`, async () => {
    const { vm, calls } = await fixture(
      binary,
      `
var names=${methodList},rejected=0;
for(var i=0;i<names.count;i++){
  try{Storages[names[i]](<% 01 02 %>);}catch(error){rejected++;}
  try{var answer=Storages[names[i]](<% 03 04 %>);}catch(error){rejected++;}
}
`,
    )
    try {
      assert.equal(await vm.execute('rejected', '', true), 18n)
      assert.deepEqual(calls, [])
    } finally {
      vm.dispose()
    }
  })

  test(`Storages skips seven discarded results but evaluates arguments and always changes auto paths (${mode})`, async () => {
    const { vm, calls } = await fixture(
      binary,
      `
var names=${methodList},evaluated=0;
function path(){evaluated++;return "unsupported://host/x";}
function extra(){evaluated++;return <% 01 %>;}
for(var i=2;i<names.count;i++)Storages[names[i]](path(),extra());
Storages.addAutoPath("first/",extra());
Storages.removeAutoPath("first/",extra());
var add=Storages.addAutoPath("second/",extra()),remove=Storages.removeAutoPath("second/",extra());
var returnsVoid=add===void && remove===void;
`,
    )
    try {
      assert.equal(await vm.execute('evaluated', '', true), 18n)
      assert.equal(await vm.execute('returnsVoid', '', true), 1n)
      assert.deepEqual(calls, [
        { operation: 'Storages.addAutoPath', path: 'first/' },
        { operation: 'Storages.removeAutoPath', path: 'first/' },
        { operation: 'Storages.addAutoPath', path: 'second/' },
        { operation: 'Storages.removeAutoPath', path: 'second/' },
      ])
    } finally {
      vm.dispose()
    }
  })

  test(`Storages native dispatch ignores borrowed receiver and global host replacements (${mode})`, async () => {
    const { vm, calls } = await fixture(
      binary,
      `
var intercepted=0,names=${methodList},mismatch=0;
var receiver=%[sentinel:"untouched",__host:function(){intercepted++;throw "receiver host";}];
global.__host=function(){intercepted++;throw "global host";};
for(var i=0;i<names.count;i++){
  var borrowed=Storages[names[i]] incontextof receiver;
  var answer=borrowed("borrowed");
  if(i<2 ? answer!==void : answer!=="borrowed")mismatch++;
}
// incontextof null clears the bound context; ordinary TJS closure dispatch
// still chooses its non-null call-site/Object fallback receiver.
var detached=Storages.extractStorageName incontextof null;
var detachedResult=detached("detached");
`,
    )
    try {
      assert.equal(await vm.execute('intercepted', '', true), 0n)
      assert.equal(await vm.execute('mismatch', '', true), 0n)
      assert.equal(await vm.execute('receiver.sentinel', '', true), 'untouched')
      assert.equal(await vm.execute('detachedResult', '', true), 'detached')
      assert.deepEqual(calls, [
        ...methods.map((method) => ({ operation: operation(method), path: 'borrowed' })),
        { operation: 'Storages.extractStorageName', path: 'detached' },
      ])
    } finally {
      vm.dispose()
    }
  })

  test(`Storages host exceptions leave all native methods usable without temporary handles (${mode})`, async () => {
    const { vm, calls } = await fixture(
      binary,
      `
var names=${methodList},rejected=0,messages=[];
for(var i=0;i<names.count;i++){
  try{var answer=Storages[names[i]]("host-reject");}
  catch(error){rejected++;messages.add(error.message);}
}
try{Storages.addAutoPath("host-reject");}catch(error){rejected++;messages.add(error.message);}
try{Storages.removeAutoPath("host-reject");}catch(error){rejected++;messages.add(error.message);}
var recovered=Storages.getFullPath("recovered");
`,
    )
    try {
      assert.equal(await vm.execute('rejected', '', true), 11n)
      assert.equal(await vm.execute('recovered', '', true), 'recovered')
      const messages = await vm.execute('messages.join("\\n")', '', true)
      assert.equal(typeof messages, 'string')
      assert.equal(
        (messages as string)
          .split('\n')
          .filter((message) => message.includes('storage-native-host-failure')).length,
        11,
      )
      assert.deepEqual(calls, [
        ...methods.map((method) => ({ operation: operation(method), path: 'host-reject' })),
        { operation: 'Storages.addAutoPath', path: 'host-reject' },
        { operation: 'Storages.removeAutoPath', path: 'host-reject' },
        { operation: 'Storages.getFullPath', path: 'recovered' },
      ])
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      vm.dispose()
    }
  })
}
