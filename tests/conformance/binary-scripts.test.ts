import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { isScriptObject, type ScriptValue } from '../../src/engine/script/runtime.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'
import { headless } from '../helpers/headless.ts'
import {
  binaryValue,
  binaryHeader,
  binaryScriptsFixture,
  bytecodeOffsets,
} from '../helpers/binary-scripts.ts'
import { exerciseBinaryRuntime } from '../helpers/binary-runtime.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
const runtime = () =>
  TjsWasmRuntime.create(
    factory,
    () => {
      throw new Error('Unexpected host callback')
    },
    { wasmBinary },
  )

for (const cancel of [false, true])
  test(`native binary deserialization pauses and ${cancel ? 'cancels' : 'resumes'} without host I/O`, async (t) => {
    t.diagnostic(
      JSON.stringify(await exerciseBinaryRuntime(factory, wasmBinary, 'asyncify', cancel)),
    )
  })

test('compiled string constants preserve embedded NUL and lone UTF-16 surrogates', async () => {
  const vm = await runtime()
  try {
    for (const source of ['"a\\x0000b"', '"\\xd800"']) {
      const expected = await vm.execute(source, '', true)
      const code = await vm.compile(source, 'unicode-bytecode.tjs', true)
      assert.equal(await vm.execute(code), expected)
    }
  } finally {
    vm.dispose()
  }
})

test('bytecode preserves normal, forwarded and expanded function arguments and nested try flow', async () => {
  const vm = await runtime()
  try {
    const source =
      'function add(a,b){return a+b;} function forward(*){return add(...);} function expanded(args*){return add(args*);} var value=0; try {try {value=forward(20,22);}catch(e){value=0;}}catch(e){value=0;} var answer=value+expanded(10,32);'
    await vm.execute(source)
    const expected = await vm.execute('answer', '', true)
    const compiled = await vm.compile(source)
    await vm.execute(compiled)
    assert.equal(await vm.execute('answer', '', true), expected)
    assert.equal(expected, 84n)
  } finally {
    vm.dispose()
  }
})

test('Scripts reads independent binary objects, native writer output and explicit offsets', async () => {
  const { session, logs } = await headless(binaryScriptsFixture())
  try {
    await session.start()
    assert(logs.includes('binary-scripts-ready'))
  } finally {
    await session.stop()
  }
})

test('serialized scalars preserve signed integers, booleans, floats, octets and UTF-16 units', async () => {
  const vm = await runtime()
  try {
    for (const value of [
      undefined,
      null,
      -32n,
      -1n,
      0n,
      127n,
      128n,
      -(1n << 63n),
      (1n << 63n) - 1n,
      1.25,
      Infinity,
      '日😀\0x',
      '\ud800',
      '',
      new Uint8Array(),
      new Uint8Array([0, 255]),
    ])
      assert.deepEqual(await vm.execute(binaryValue(value)), value)
    const tagged: [number[], ScriptValue][] = [
      [[0xc2], 1n],
      [[0xc3], 0n],
      [[0xcc, 255], 255n],
      [[0xcd, 255, 255], 65535n],
      [[0xce, 255, 255, 255, 255], 4294967295n],
      [[0xcf, ...new Array<number>(8).fill(255)], -1n],
      [[0xd0, 128], -128n],
      [[0xd1, 0, 128], -32768n],
      [[0xd2, 0, 0, 0, 128], -2147483648n],
      [[0xca, 0, 0, 192, 63], 1.5],
    ]
    for (const [bytes, value] of tagged)
      assert.deepEqual(await vm.execute(new Uint8Array([...binaryHeader, ...bytes])), value)
    assert(Number.isNaN(await vm.execute(binaryValue(NaN))))
    assert.equal(vm.inspect().handles, 0)
  } finally {
    vm.dispose()
  }
})

test('serialized strings and octets accept each length encoding and return independent native arrays', async () => {
  const vm = await runtime()
  try {
    for (const size of [0, 1, 5, 6, 31, 32, 255, 256, 65535, 65536]) {
      const text = '字'.repeat(size),
        bytes = new Uint8Array(size).fill(127)
      assert.equal(await vm.execute(binaryValue(text)), text)
      assert.deepEqual(await vm.execute(binaryValue(bytes)), bytes)
    }
    for (const size of [0, 15, 16, 65536]) {
      const value = await vm.execute(binaryValue(new Array<bigint>(size).fill(7n)))
      assert(isScriptObject(value))
      vm.release(value)
    }
    assert.equal(await vm.execute('6*7', '', true), 42n)
    assert.equal(vm.inspect().handles, 0)
  } finally {
    vm.dispose()
  }
})

test('truncated and oversized binary values fail with recoverable script errors', async () => {
  const vm = await runtime()
  const bytes = binaryValue(new Map([['value', [1n, 'text', new Uint8Array([1, 2, 3])]]]))
  try {
    for (let size = 0; size < bytes.length; size++)
      await assert.rejects(vm.execute(bytes.subarray(0, size)), { name: 'ScriptError' })
    for (const payload of [
      [0xc7],
      [0xc8],
      [0xc9],
      [0xc6, 255, 255, 255, 255],
      [0xdb, 255, 255, 255, 255],
      [0xdd, 255, 255, 255, 255],
      [0xdf, 255, 255, 255, 255],
      [0x81, 1, 2],
      [...new Array<number>(258).fill(0x91), 0],
    ])
      await assert.rejects(vm.execute(new Uint8Array([...binaryHeader, ...payload])), {
        name: 'ScriptError',
      })
    assert.equal(await vm.execute('6*7', '', true), 42n)
    assert.equal(vm.inspect().handles, 0)
  } finally {
    vm.dispose()
  }
})

test('script stream offsets apply before binary detection and preserve text decoding', async () => {
  const vm = await runtime()
  try {
    const compiled = await vm.compile('6*7', 'offset.tjs', true)
    const prefixed = new Uint8Array(13 + compiled.length)
    prefixed.set(compiled, 13)
    const source = await readScript(prefixed, 'o13')
    assert(source instanceof Uint8Array)
    assert.equal(await vm.execute(source), 42n)
    assert.equal(await readScript(new TextEncoder().encode('prefix6*7'), 'o6'), '6*7')
    await assert.rejects(readScript(prefixed, 'o999999'), /offset/)
    const contextual = await vm.compile('(value+=2,value)', 'contextual.tjs', true)
    const wrapped = new Uint8Array(13 + contextual.length)
    wrapped.set(contextual, 13)
    const { session } = await headless({
      'startup.tjs':
        'var scope=%[value:40];var result=Scripts.evalStorage("wrapped.cjs","o13",scope);',
      'wrapped.cjs': wrapped,
    })
    try {
      await session.start()
      assert.equal(await session.evaluate('result'), '42')
      assert.equal(await session.evaluate('scope.value'), '42')
    } finally {
      await session.stop()
    }
  } finally {
    vm.dispose()
  }
})

test('bytecode rejects truncation, invalid chunk lengths, pool counts and context dimensions', async () => {
  const vm = await runtime()
  try {
    const original = await vm.compile('6*7', 'validation.tjs', true)
    for (let size = 0; size < original.length; size++)
      await assert.rejects(vm.execute(original.subarray(0, size)), { name: 'ScriptError' })
    const layout = bytecodeOffsets(original),
      object = layout.objects[0]!
    const patches: [number, number][] = [
      [4, 0],
      [8, 0],
      [16, 0],
      [16, 0xffffffff],
      [layout.objectsStart + 4, 0xffffffff],
      [layout.objectsStart + 8, 9999],
      [layout.objectsStart + 12, 0xffffffff],
      [object.length, 0xffffffff],
      [object.start, 0],
      [object.start + 4, 0x7fffffff],
      [object.start + 8, 99],
      ...[12, 16, 20, 24, 28, 32, 36, 40, 44].map((offset): [number, number] => [
        object.start + offset,
        0x7fffffff,
      ]),
      [object.debugCount, 0xffffffff],
      [object.codeCount, 0xffffffff],
      [object.dataCount, 0xffffffff],
      [object.superCount, 0xffffffff],
      [object.propertiesCount, 0xffffffff],
      ...layout.pools.map((pool): [number, number] => [pool.count, 0xffffffff]),
      ...layout.pools
        .filter((pool) => pool.length !== undefined)
        .map((pool): [number, number] => [pool.length!, 0xffffffff]),
    ]
    for (const [offset, value] of patches) {
      const bytes = original.slice()
      new DataView(bytes.buffer).setUint32(offset, value, true)
      await assert.rejects(vm.execute(bytes), { name: 'ScriptError' }, `field ${offset} = ${value}`)
    }
    assert.equal(await vm.execute(original), 42n)
  } finally {
    vm.dispose()
  }
})

test('bytecode rejects unknown opcodes, out-of-range registers/constants and malformed final instructions', async () => {
  const vm = await runtime()
  try {
    const original = await vm.compile('42', 'operands.tjs', true)
    const object = bytecodeOffsets(original).objects[0]!
    for (const [word, value] of [
      [0, 0x7fff],
      [1, -32768],
      [1, 32767],
      [2, 32767],
      [object.codeWords.length - 1, 1],
    ]) {
      const bytes = original.slice()
      new DataView(bytes.buffer).setInt16(object.code + word! * 2, value!, true)
      await assert.rejects(vm.execute(bytes), { name: 'ScriptError' })
    }
    assert.equal(await vm.execute(original), 42n)
  } finally {
    vm.dispose()
  }
})

test('bytecode context references and control-flow destinations must point to valid objects and instructions', async () => {
  const vm = await runtime()
  try {
    const source =
      'class Box {function value(){return 7;} property p {getter(){return 9;}}} var box=new Box; var result=box.value()+box.p; if(result>0)result+=26;'
    const original = await vm.compile(source, 'objects.tjs'),
      layout = bytecodeOffsets(original)
    for (const object of layout.objects.slice(1)) {
      const bytes = original.slice()
      new DataView(bytes.buffer).setInt32(object.start, layout.objects.indexOf(object), true)
      await assert.rejects(vm.execute(bytes), { name: 'ScriptError' })
    }
    const top = layout.objects[0]!,
      branch = top.codeWords.findIndex((code) => code === 15 || code === 16)
    assert(branch >= 0)
    for (const destination of [1, 32767, -32768]) {
      const bytes = original.slice()
      new DataView(bytes.buffer).setInt16(top.code + (branch + 1) * 2, destination, true)
      await assert.rejects(vm.execute(bytes), { name: 'ScriptError' })
    }
    await vm.execute(original)
    assert.equal(await vm.execute('result', '', true), 42n)
  } finally {
    vm.dispose()
  }
})
