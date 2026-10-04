import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import type { HostReply, ScriptValue } from '../../src/engine/script/runtime.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

interface Call {
  operation: string
  args: ScriptValue[]
}
interface Write {
  operation: string
  path: string
  mode: string
  value: string | Uint8Array
}

/** The real native stream factories choose the operation and serializer.
 * This host observes their boundary only; text mode policy and storage are
 * tested separately through the production Session, not reproduced here. */
async function boundary(
  preflight?: (operation: string, name: string, mode: string) => HostReply | Promise<HostReply>,
) {
  const calls: Call[] = []
  const writes: Write[] = []
  const vm = await TjsWasmRuntime.create(
    factory,
    async (operation, args): Promise<HostReply> => {
      calls.push({ operation, args: [...args] })
      if (operation === 'After') return { kind: 'value', value: args[0] }
      assert(typeof args[0] === 'string')
      assert(typeof args[1] === 'string')
      if (operation === 'Storage.validateTextWrite' || operation === 'Storage.validateWrite') {
        assert.equal(args.length, 2)
        // Complete after suspension, so a rejection must cross the actual
        // native factory call back to its original TJS try/catch.
        await Promise.resolve()
        if (operation === 'Storage.validateTextWrite' && args[0].startsWith('rejected-'))
          throw new Error(`text-preflight:${args[0]}`)
        return preflight
          ? await preflight(operation, args[0], args[1])
          : { kind: 'value', value: args[0] }
      }
      assert(operation === 'Storage.writeText' || operation === 'Storage.writeBinary', operation)
      assert.equal(args.length, 3)
      const value = args[2]
      if (operation === 'Storage.writeText') assert.equal(typeof value, 'string')
      else assert(value instanceof Uint8Array)
      assert(typeof value === 'string' || value instanceof Uint8Array)
      writes.push({
        operation,
        path: args[0],
        mode: args[1],
        value: typeof value === 'string' ? value : value.slice(),
      })
      return { kind: 'value', value: undefined }
    },
    { wasmBinary },
  )
  return { vm, calls, writes }
}

async function execute(vm: TjsWasmRuntime, binary: boolean, source: string) {
  const input = binary ? await vm.compile(source, 'text-writer-native.tjs') : source
  if (binary) {
    assert(input instanceof Uint8Array)
    assert.equal(new TextDecoder().decode(input.subarray(0, 4)), 'TJS2')
  }
  await vm.execute(input, binary ? 'text-writer-native.cjs' : 'text-writer-native.tjs')
}

test('native write target binding capability retains ABI 5, Storages 2 and PhaseVocoder 1', async () => {
  assert.equal(manifest.abi, 5)
  assert.equal(manifest.capabilities?.nativeTextStreams, 2)
  assert.equal(manifest.capabilities?.nativeStorages, 2)
  assert.equal(manifest.capabilities?.nativePhaseVocoder, 1)
})

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`every native writer queues the preflight target through host-call and final flushes (${mode})`, async () => {
    let targetIndex = 0
    const { vm, calls, writes } = await boundary((_operation, name) => ({
      kind: 'value',
      value: `game://./bound/雪-${targetIndex++}/${name}`,
    }))
    try {
      await execute(
        vm,
        binary,
        `
var array=["雪",7],dictionary=%[text:"雪",number:7];
array.save("array.txt","b");__host("After",0);
array.saveStruct("array-struct.txt");__host("After",1);
(Dictionary.saveStruct incontextof dictionary)("dictionary-struct.txt");__host("After",2);
array.saveStruct("array.bin","b");__host("After",3);
(Dictionary.saveStruct incontextof dictionary)("dictionary.bin","b");
`,
      )
      const requested = [
        'array.txt',
        'array-struct.txt',
        'dictionary-struct.txt',
        'array.bin',
        'dictionary.bin',
      ]
      assert.deepEqual(
        calls
          .filter((call) => call.operation.startsWith('Storage.validate'))
          .map((call) => call.args[0]),
        requested,
      )
      assert.deepEqual(
        writes.map((write) => write.path),
        requested.map((name, index) => `game://./bound/雪-${index}/${name}`),
      )
      assert.deepEqual(
        writes.map((write) => write.operation),
        [
          'Storage.writeText',
          'Storage.writeText',
          'Storage.writeText',
          'Storage.writeBinary',
          'Storage.writeBinary',
        ],
      )
      assert.deepEqual(
        calls.map((call) => call.operation),
        requested.flatMap((_name, index) => [
          index < 3 ? 'Storage.validateTextWrite' : 'Storage.validateWrite',
          index < 3 ? 'Storage.writeText' : 'Storage.writeBinary',
          ...(index < 4 ? ['After'] : []),
        ]),
      )
      assert.equal(writes[0]!.value, '雪\r\n7\r\n')
      for (const write of writes.slice(3)) {
        assert(write.value instanceof Uint8Array)
        assert.deepEqual([...write.value.subarray(0, 8)], [75, 66, 65, 68, 49, 48, 48, 0])
      }
      await vm.flush()
      assert.equal(writes.length, 5, 'A second flush cannot queue a second write')
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      vm.dispose()
    }
  })

  test(`native writers reject invalid preflight replies before creating a queued stream (${mode})`, async () => {
    let reply: HostReply | Error = { kind: 'value', value: undefined }
    const { vm, writes } = await boundary(() => {
      if (reply instanceof Error) throw reply
      return reply
    })
    try {
      await execute(
        vm,
        binary,
        `
var array=["pending"],dictionary=%[text:"pending"],redirected=0;
function attempt(index){
  try{
    if(index===0)array.save("request.txt");
    else if(index===1)array.saveStruct("request.txt");
    else if(index===2)(Dictionary.saveStruct incontextof dictionary)("request.txt");
    else if(index===3)array.saveStruct("request.bin","b");
    else (Dictionary.saveStruct incontextof dictionary)("request.bin","b");
    return "accepted";
  }catch(error){return error.message;}
}
`,
      )
      const invalidValues: ScriptValue[] = [
        undefined,
        null,
        '',
        0n,
        1.5,
        new Uint8Array([1]),
        { type: 'array', items: [] },
        { type: 'dictionary', entries: {} },
      ]
      const invalid: HostReply[] = [
        ...invalidValues.map((value): HostReply => ({ kind: 'value', value })),
        { kind: 'script', source: 'redirected++;"untrusted.txt"', name: 'invalid-preflight.tjs' },
        { kind: 'dump' },
      ]
      for (reply of invalid) {
        for (let index = 0; index < 5; index++) {
          assert.match(
            String(await vm.execute(`attempt(${index})`, '', true)),
            /Storage write preflight returned an invalid target/,
          )
          assert.equal(writes.length, 0)
        }
      }
      reply = new Error('write-preflight-denied')
      for (let index = 0; index < 5; index++)
        assert.equal(await vm.execute(`attempt(${index})`, '', true), 'write-preflight-denied')
      await vm.flush()
      assert.equal(writes.length, 0, 'Rejected construction must never leave a deferred write')
      assert.equal(await vm.execute('redirected', '', true), 0n)

      reply = { kind: 'value', value: 'game://./bound/recovered.txt' }
      assert.equal(await vm.execute('attempt(0)', '', true), 'accepted')
      assert.deepEqual(writes, [
        {
          operation: 'Storage.writeText',
          path: 'game://./bound/recovered.txt',
          mode: '',
          value: 'pending\r\n',
        },
      ])
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      vm.dispose()
    }
  })

  test(`Array.save selects native text preflight even with binary mode characters (${mode})`, async () => {
    const { vm, calls, writes } = await boundary()
    try {
      await execute(
        vm,
        binary,
        `
var values=["雪",7],modes=["b","bc0","bc9","bz"],mismatch=0;
for(var i=0;i<modes.count;i++)
  if(values.save("array-"+i+".txt",modes[i])!==values)mismatch++;
`,
      )
      assert.equal(await vm.execute('mismatch', '', true), 0n)
      assert.deepEqual(
        calls.filter((call) => call.operation.startsWith('Storage.validate')),
        ['b', 'bc0', 'bc9', 'bz'].map((value, index) => ({
          operation: 'Storage.validateTextWrite',
          args: [`array-${index}.txt`, value],
        })),
      )
      assert.equal(writes.length, 4)
      for (const [index, write] of writes.entries()) {
        assert.equal(write.operation, 'Storage.writeText')
        assert.equal(write.path, `array-${index}.txt`)
        assert.equal(write.mode, ['b', 'bc0', 'bc9', 'bz'][index])
        assert.equal(typeof write.value, 'string')
        assert.equal((write.value as string).replaceAll('\r\n', '\n'), '雪\n7\n')
      }
    } finally {
      vm.dispose()
    }
  })

  test(`Array and Dictionary saveStruct keep bc0, bc9 and bz on the binary stream (${mode})`, async () => {
    const { vm, calls, writes } = await boundary()
    try {
      await execute(
        vm,
        binary,
        `
var array=["雪",7],dictionary=%[text:"雪",number:7],modes=["b","bc0","bc9","bz"],mismatch=0;
for(var i=0;i<modes.count;i++){
  if(array.saveStruct("array-"+i+".bin",modes[i])!==array)mismatch++;
  if((Dictionary.saveStruct incontextof dictionary)("dictionary-"+i+".bin",modes[i])!==dictionary)mismatch++;
}
`,
      )
      assert.equal(await vm.execute('mismatch', '', true), 0n)
      assert.deepEqual(
        calls.filter((call) => call.operation.startsWith('Storage.validate')),
        ['b', 'bc0', 'bc9', 'bz'].flatMap((value, index) =>
          ['array', 'dictionary'].map((kind) => ({
            operation: 'Storage.validateWrite',
            args: [`${kind}-${index}.bin`, value],
          })),
        ),
      )
      assert.equal(writes.length, 8)
      for (const [index, write] of writes.entries()) {
        const kind = index % 2 === 0 ? 'array' : 'dictionary'
        assert.equal(write.operation, 'Storage.writeBinary')
        assert.equal(write.path, `${kind}-${Math.floor(index / 2)}.bin`)
        assert.equal(write.mode, ['b', 'bc0', 'bc9', 'bz'][Math.floor(index / 2)])
        assert(write.value instanceof Uint8Array)
        assert.deepEqual([...write.value.subarray(0, 8)], [75, 66, 65, 68, 49, 48, 48, 0])
        assert.deepEqual(write.value, writes[index % 2]!.value)
      }
    } finally {
      vm.dispose()
    }
  })

  test(`suspended text preflight rejects at each native save call without queuing bytes (${mode})`, async () => {
    const { vm, calls, writes } = await boundary()
    try {
      await execute(
        vm,
        binary,
        `
var array=["雪",7],dictionary=%[text:"雪"],errors=[],sentinel=0;
try{array.save("rejected-array.txt","bc0");sentinel=-100;}catch(error){errors.add(error.message);sentinel++;}
try{array.saveStruct("rejected-array-struct.txt","c0");sentinel=-100;}catch(error){errors.add(error.message);sentinel++;}
try{(Dictionary.saveStruct incontextof dictionary)("rejected-dictionary-struct.txt","c9");sentinel=-100;}catch(error){errors.add(error.message);sentinel++;}
var after=__host("After",sentinel);
array.save("accepted.txt","b");
`,
      )
      assert.equal(await vm.execute('[sentinel,after].join("|")', '', true), '3|3')
      assert.equal(
        await vm.execute('errors.join("|")', '', true),
        'text-preflight:rejected-array.txt|text-preflight:rejected-array-struct.txt|text-preflight:rejected-dictionary-struct.txt',
      )
      assert.deepEqual(
        calls.map((call) => [call.operation, ...call.args.slice(0, 2)]),
        [
          ['Storage.validateTextWrite', 'rejected-array.txt', 'bc0'],
          ['Storage.validateTextWrite', 'rejected-array-struct.txt', 'c0'],
          ['Storage.validateTextWrite', 'rejected-dictionary-struct.txt', 'c9'],
          ['After', 3n],
          ['Storage.validateTextWrite', 'accepted.txt', 'b'],
          ['Storage.writeText', 'accepted.txt', 'b'],
        ],
      )
      assert.equal(writes.length, 1)
      assert.equal(writes[0]!.path, 'accepted.txt')
      await vm.flush()
      assert.equal(writes.length, 1, 'Rejected native construction cannot leave a deferred write')
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      vm.dispose()
    }
  })
}
