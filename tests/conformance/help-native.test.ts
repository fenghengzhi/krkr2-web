import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import type { HostReply, ScriptValue } from '../../src/engine/script/runtime.ts'
import { systemClass, systemClassValue } from '../../src/engine/tvp/system-class.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

// Observe actual native calls and conversions. This boundary host deliberately
// does not implement the VFS or document UI, which have separate tests.
async function boundary() {
  const calls: { operation: string; args: ScriptValue[] }[] = []
  let shellResult: ScriptValue = 7n
  const vm = await TjsWasmRuntime.create(
    factory,
    async (operation, args): Promise<HostReply> => {
      if (operation === 'System.class')
        return { kind: 'value', value: systemClassValue(args) }
      if (operation === 'StoragesFactory')
        return {
          kind: 'value',
          value: {
            type: 'class', namespace: 'Storages', className: 'Storages', id: 0, properties: [],
          },
        }
      calls.push({ operation, args: [...args] })
      assert(args.every((argument) => typeof argument === 'string'))
      await Promise.resolve()
      if (args[0] === 'rejected.txt') throw new Error(`help-host-failed:${operation}`)
      if (operation === 'Storages.getLocalName') {
        assert.equal(args.length, 1)
        return { kind: 'value', value: `local:${args[0]}` }
      }
      assert.equal(operation, 'System.shellExecute')
      assert.equal(args.length, 2)
      return { kind: 'value', value: shellResult }
    },
    { wasmBinary },
  )
  return {
    vm,
    calls,
    answer(value: ScriptValue) { shellResult = value },
  }
}

async function execute(vm: TjsWasmRuntime, binary: boolean, source: string) {
  const program = `${systemClass}\nvar Storages=__host("StoragesFactory");\n${source}`
  const input = binary ? await vm.compile(program, 'help-native.tjs') : program
  if (binary) {
    assert(input instanceof Uint8Array)
    assert.equal(new TextDecoder().decode(input.subarray(0, 4)), 'TJS2')
  }
  await vm.execute(input, binary ? 'help-native.cjs' : 'help-native.tjs')
}

test('native Help is independently advertised without changing System or Storages', async () => {
  assert.equal(manifest.abi, 5)
  assert.equal(manifest.capabilities?.nativeHelp, 1)
  assert.equal(manifest.capabilities?.nativeSystem, 2)
  assert.equal(manifest.capabilities?.nativeStorages, 2)
})

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`help methods keep native identity, minargs, borrowed receivers and ignored extras (${mode})`, async () => {
    const { vm, calls } = await boundary()
    try {
      await execute(vm, binary, `
var identity=[System instanceof "System",Storages instanceof "Storages",
  System.shellExecute instanceof "Function",Storages.getLocalName instanceof "Function"].join("|");
var missing=0,extraCalls=0,intercepted=0;
try{System.shellExecute();}catch(error){missing++;}
try{var bad=System.shellExecute();}catch(error){missing++;}
try{Storages.getLocalName();}catch(error){missing++;}
try{var bad=Storages.getLocalName();}catch(error){missing++;}
function extra(){extraCalls++;return <% 01 %>;}
var receiver=%[sentinel:"unchanged",__host:function(){throw "wrong receiver host";}];
var local=Storages.getLocalName incontextof receiver,shell=System.shellExecute incontextof receiver;
global.__host=function(){intercepted++;throw new Exception("replaced script host");};
var name=local("help.txt",extra());
local(<% 02 %>,extra());
shell("help.txt",void,extra());
var accepted=shell("help.txt",42,extra());
`)
      assert.equal(await vm.execute('identity', '', true), '1|1|1|1')
      assert.equal(await vm.execute('missing', '', true), 4n)
      assert.equal(await vm.execute('name', '', true), 'local:help.txt')
      assert.equal(await vm.execute('accepted', '', true), 7n)
      assert.equal(await vm.execute('[extraCalls,intercepted,receiver.sentinel].join("|")', '', true), '4|0|unchanged')
      assert.deepEqual(calls, [
        { operation: 'Storages.getLocalName', args: ['help.txt'] },
        { operation: 'System.shellExecute', args: ['help.txt', ''] },
        { operation: 'System.shellExecute', args: ['help.txt', '42'] },
      ])
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      vm.dispose()
    }
  })

  test(`getLocalName discards conversion and host work while preserving argument evaluation (${mode})`, async () => {
    const { vm, calls } = await boundary()
    try {
      await execute(vm, binary, `
var reads=0,extraReads=0,failures=[],converted=0;
property octetArgument {getter(){reads++;return <% 11 22 %>;}}
property extraArgument {getter(){extraReads++;return <% 33 %>;}}
property throwingArgument {getter(){throw new Exception("argument-evaluation");}}
Storages.getLocalName(octetArgument,extraArgument);
try{var value=Storages.getLocalName(octetArgument,extraArgument);}catch(error){converted++;}
try{Storages.getLocalName(throwingArgument);}catch(error){failures.add(error.message);}
try{Storages.getLocalName("unused",throwingArgument);}catch(error){failures.add(error.message);}
// Existing path methods still perform conversion before discarding a result.
try{Storages.getFullPath(<% 44 %>);}catch(error){converted++;}
Storages.getLocalName("rejected.txt");
var after=Storages.getLocalName("accepted.txt");
`)
      assert.equal(await vm.execute('[reads,extraReads,converted].join("|")', '', true), '2|2|2')
      assert.equal(await vm.execute('failures.join("|")', '', true), 'argument-evaluation|argument-evaluation')
      assert.equal(await vm.execute('after', '', true), 'local:accepted.txt')
      assert.deepEqual(calls, [{ operation: 'Storages.getLocalName', args: ['accepted.txt'] }])
    } finally {
      vm.dispose()
    }
  })

  test(`help uses TJS primitive and object conversion, including explicit void execparam (${mode})`, async () => {
    const { vm, calls } = await boundary()
    try {
      await execute(vm, binary, `
var hooks=0;
class Argument {function toString(){global.hooks++;throw new Exception("must not call toString");}}
var object=new Argument();
var expectedObject=string(object),expectedNull=string(null);
var numeric=Storages.getLocalName(9007199254740993),empty=Storages.getLocalName(void);
var convertedObject=Storages.getLocalName(object);
System.shellExecute(9007199254740993,void);
System.shellExecute(void);
System.shellExecute(object,null);
`)
      const object = await vm.execute('expectedObject', '', true),
        nullString = await vm.execute('expectedNull', '', true)
      assert.equal(typeof object, 'string')
      assert.equal(typeof nullString, 'string')
      assert.equal(await vm.execute('hooks', '', true), 0n)
      assert.deepEqual(calls, [
        { operation: 'Storages.getLocalName', args: ['9007199254740993'] },
        { operation: 'Storages.getLocalName', args: [''] },
        { operation: 'Storages.getLocalName', args: [object] },
        { operation: 'System.shellExecute', args: ['9007199254740993', ''] },
        { operation: 'System.shellExecute', args: ['', ''] },
        { operation: 'System.shellExecute', args: [object, nullString] },
      ])
    } finally {
      vm.dispose()
    }
  })

  test(`shellExecute converts target before execparam even for discarded results (${mode})`, async () => {
    const { vm, calls } = await boundary()
    try {
      await execute(vm, binary, `
var target=<% 11 22 %>,parameters=<% 33 44 %>,errors=[],argumentReads=0;
function conversionError(value){try{var converted=string(value);return "accepted";}catch(error){return error.message;}}
var targetError=conversionError(target),parameterError=conversionError(parameters);
property targetArgument {getter(){argumentReads++;return global.target;}}
property parameterArgument {getter(){argumentReads++;return global.parameters;}}
try{System.shellExecute(targetArgument,parameterArgument);}catch(error){errors.add(error.message);}
try{var value=System.shellExecute(targetArgument,parameterArgument);}catch(error){errors.add(error.message);}
try{System.shellExecute("accepted.txt",parameterArgument);}catch(error){errors.add(error.message);}
try{var value=System.shellExecute("accepted.txt",parameterArgument);}catch(error){errors.add(error.message);}
System.shellExecute("accepted.txt",void,<% 55 %>);
`)
      const targetError = await vm.execute('targetError', '', true),
        parameterError = await vm.execute('parameterError', '', true)
      assert.notEqual(targetError, parameterError, 'Distinct octets must identify the failed conversion')
      assert.equal(await vm.execute('errors.join("|")', '', true), [targetError, targetError, parameterError, parameterError].join('|'))
      assert.equal(await vm.execute('argumentReads', '', true), 6n)
      assert.deepEqual(calls, [{ operation: 'System.shellExecute', args: ['accepted.txt', ''] }])
    } finally {
      vm.dispose()
    }
  })

  test(`help host failures stay on the original native stack and later calls recover (${mode})`, async () => {
    const { vm, calls, answer } = await boundary()
    try {
      await execute(vm, binary, `
var failures=[];
try{var name=Storages.getLocalName("rejected.txt");}catch(error){failures.add(error.message);}
try{System.shellExecute("rejected.txt");}catch(error){failures.add(error.message);}
try{var accepted=System.shellExecute("rejected.txt",void);}catch(error){failures.add(error.message);}
var recovered=System.shellExecute("accepted.txt");
function openAgain(){return System.shellExecute("again.txt");}
function discardAgain(){System.shellExecute("again.txt");}
`)
      assert.equal(await vm.execute('failures.join("|")', '', true), [
        'help-host-failed:Storages.getLocalName',
        'help-host-failed:System.shellExecute',
        'help-host-failed:System.shellExecute',
      ].join('|'))
      assert.equal(await vm.execute('recovered', '', true), 7n)
      answer(0n)
      assert.equal(await vm.execute('openAgain()', '', true), 0n)
      answer(9007199254740993n)
      assert.equal(await vm.execute('openAgain()', '', true), 9007199254740993n)
      answer('1')
      await assert.rejects(vm.execute('openAgain()', '', true), /System.shellExecute returned an invalid result/)
      await assert.rejects(vm.execute('discardAgain()'), /System.shellExecute returned an invalid result/)
      answer(1n)
      assert.equal(await vm.execute('openAgain()', '', true), 1n)
      assert.equal(calls.length, 9)
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      vm.dispose()
    }
  })
}
