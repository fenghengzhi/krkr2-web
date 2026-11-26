import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, NativeModule, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type { HostHandler } from '../../src/engine/script/runtime.ts'
import { graphicCacheSystemLimit } from '../../src/engine/system/graphic-cache-option.ts'

const directory = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest,
  assets = manifest.variants.asyncify!,
  { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
const integers: readonly (readonly [string, number])[] = [
  ['', 0], ['auto', 0], ['AUTO', 0], ['no', 0], ['32', 32], ['32MiB', 32], ['(16+16)', 0],
  [' 32', 0], ['\t32', 0], ['+ 32', 32], ['-\t2', -2], ['+', 0], ['-', 0], ['32 ', 32],
  ['1.75', 1], ['-1.75', -1], ['0.75', 0], ['1e2', 100], ['1e-2', 0], ['1e + 2', 100],
  ['040', 32], ['09', 0], ['0x20', 32], ['0X20tail', 32], ['0b100000', 32], ['0x1.8p1', 3],
  ['true', 1], ['false', 0], ['true9', 1], ['truex', 0], ['-true', -1],
  ['12\0ignored', 12], ['1\uffff2', 12],
  ['2147483647', 2147483647], ['2147483648', -2147483648], ['4294967295', -1],
  ['4294967297', 1], ['9007199254740993', 1], ['0xffffffff', -1],
]

async function using(
  body: (fixture: { vm: TjsWasmRuntime; module: NativeModule; control: ExecutionControl }) => Promise<void>,
  handler: HostHandler = () => { throw new Error('Startup option conversion entered game code') },
  omit = false,
) {
  let module!: NativeModule
  const control = new ExecutionControl(), vm = await TjsWasmRuntime.create(async (options) => {
    module = await factory(options)
    if (omit) delete module._krkr_parse_option_integer
    return module
  }, handler, { wasmBinary, control }), failures: unknown[] = []
  try { await body({ vm, module, control }) } catch (error) { failures.push(error) }
  try {
    control.cancel(); vm.dispose()
    assert.equal(Number(module._krkr_native_lifetime_stat!(4)), 0)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Native startup option conversion or cleanup failed', { cause: failures[0] })
}

test('startup strings use the original TJS number grammar and signed32 conversion without executing script', { timeout: 60000 }, async () => {
  await using(async ({ vm }) => {
    const handles = vm.inspect().handles
    for (const [text, expected] of integers) assert.equal(vm.parseOptionInteger(text), expected, JSON.stringify(text))
    assert.equal(vm.inspect().handles, handles)
    assert.equal(await vm.execute('6*7', 'after-options.tjs', true), 42n)
  })
})

test('gclim distinguishes automatic choice from uint32 MiB arithmetic without enabling a cache', { timeout: 60000 }, async () => {
  await using(async ({ vm }) => {
    const parse = (text: string) => vm.parseOptionInteger(text), auto = 64 * 1024 * 1024
    for (const value of [undefined, 'auto', 'auto\0tail'])
      assert.equal(graphicCacheSystemLimit(value, () => assert.fail('Exact auto must not require a native parser')), auto)
    for (const value of ['-1', '-1.75', '4294967295', '0xffffffff', '-true'])
      assert.equal(graphicCacheSystemLimit(value, parse), auto)
    for (const [value, expected] of [['0', 0], ['AUTO', 0], [' auto', 0], ['auto ', 0], ['2', 2097152],
      ['-2', 4292870144], ['2048', 2147483648], ['4095', 4293918720], ['4096', 0], ['4097', 1048576],
      ['2147483647', 4293918720], ['2147483648', 0], ['4294967297', 1048576], ['9007199254740993', 1048576]] as const)
      assert.equal(graphicCacheSystemLimit(value, parse), expected, value)
    assert.equal(graphicCacheSystemLimit('auto', undefined, 12 * 1024 * 1024), 12 * 1024 * 1024)
    const failure = new Error('native conversion failed')
    assert.throws(() => graphicCacheSystemLimit('32', () => { throw failure }), (error) => error === failure)
    for (const value of [Number.NaN, 1.5, 0x80000000])
      assert.throws(() => graphicCacheSystemLimit('32', () => value), { message: 'Invalid native startup integer result' })
  })
})

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'} TJS int conversion agrees with literal option cases before signed32 narrowing`, { timeout: 60000 }, async () => {
    await using(async ({ vm }) => {
      for (const [text, expected] of integers) {
        // Quote UTF-16 units using original TJS's four-digit \x escape. JSON's
        // \u escapes have different TJS semantics and are not an input oracle.
        const literal = '"' + Array.from({ length: text.length }, (_, i) => '\\x' + text.charCodeAt(i).toString(16).padStart(4, '0')).join('') + '"'
        // NUL cannot be represented through native string-literal append:
        // construction omits that unit. Use the actual C-string prefix here.
        const prefix = text.split('\0', 1)[0]!, quoted = text.includes('\0')
          ? '"' + [...prefix].map((ch) => '\\x' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"' : literal
        const expression = `int(${quoted})&0xffffffff`, result = await vm.execute(
          binary ? await vm.compile(expression, 'option-integer.tjs', true) : expression,
          'option-integer.tjs', true)
        assert.equal(result, BigInt(expected >>> 0), JSON.stringify(text))
      }
    })
  })

test('legacy kernels remain usable for automatic defaults while numeric options require the actual native export', { timeout: 60000 }, async () => {
  await using(async ({ vm }) => {
    assert.equal(graphicCacheSystemLimit(undefined, undefined), 64 * 1024 * 1024)
    assert.equal(graphicCacheSystemLimit('auto', undefined), 64 * 1024 * 1024)
    assert.throws(() => graphicCacheSystemLimit('32', undefined), { message: 'Script runtime does not support native startup integer conversion' })
    assert.throws(() => vm.parseOptionInteger('32'), { message: 'TJS WASM is missing native startup integer conversion' })
    assert.equal(await vm.execute('6*7', 'legacy-default.tjs', true), 42n)
  }, undefined, true)
  await using(async ({ vm, module }) => {
    assert.throws(() => vm.parseOptionInteger(32 as unknown as string), { message: 'Startup integer option must be a string' })
    const request = Number(module._krkr_reply_new!(0))
    let reply = 0
    try {
      module._krkr_value_set_real!(Number(module._krkr_reply_value!(request)), 32)
      reply = Number(module._krkr_parse_option_integer!(request))
      assert.equal(Number(module._krkr_reply_kind!(reply)), 1, 'Native boundary also requires a genuine string variant')
    } finally {
      if (reply) module._krkr_reply_delete!(reply)
      module._krkr_reply_delete!(request)
    }
  })
})

test('startup conversion rejects active script reentry, cancellation and disposed runtimes', { timeout: 60000 }, async () => {
  let entered!: () => void, release!: () => void, retired!: TjsWasmRuntime
  const began = new Promise<void>((resolve) => { entered = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
  await using(async ({ vm, control }) => {
    retired = vm
    const pending = vm.execute('__host("wait");', 'active-options.tjs'), errors: unknown[] = []
    const settled = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
    try {
      await Promise.race([began, settled.then((result) => {
        if (!result.ok) throw result.error
        assert.fail('Script completed before its real host suspension')
      })])
      assert.throws(() => vm.parseOptionInteger('32'), { message: 'Cannot parse startup options while TJS is running' })
    } catch (error) { errors.push(error) }
    finally { release() }
    const result = await settled
    if (!result.ok) errors.push(result.error)
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Active option guard or pending script failed', { cause: errors[0] })
    control.cancel()
    assert.throws(() => vm.parseOptionInteger('32'), { name: 'AbortError' })
  }, async () => { entered(); await gate; return { kind: 'value', value: undefined } })
  assert.throws(() => retired.parseOptionInteger('32'), { message: 'TJS runtime is disposed' })
})
