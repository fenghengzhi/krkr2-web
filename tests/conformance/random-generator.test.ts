import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, ModuleOptions, NativeModule, WasmManifest, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'

const variant = (process.env.KRKR_RANDOM_VARIANT ?? 'asyncify') as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const directory = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest,
  assets = manifest.variants[variant]!,
  { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

// Independent array-index MT19937 reference, checked against the authors'
// published mt19937ar.out before use. It does not call the Wasm implementation.
// Source/output hashes: out/verification/random-generator/104-source/mt-reference-manifest.json.
class ReferenceMt {
  readonly words = new Uint32Array(624)
  private position = 624
  constructor(keys: readonly number[]) {
    this.words[0] = 19650218
    for (let i = 1; i < 624; i++) {
      const previous = this.words[i - 1]!
      this.words[i] = Math.imul(previous ^ previous >>> 30, 1812433253) + i
    }
    let i = 1, j = 0
    for (let k = Math.max(624, keys.length); k; k--) {
      const previous = this.words[i - 1]!
      this.words[i] = (this.words[i]! ^ Math.imul(previous ^ previous >>> 30, 1664525)) + keys[j]! + j
      if (++i >= 624) { this.words[0] = this.words[623]!; i = 1 }
      if (++j >= keys.length) j = 0
    }
    for (let k = 623; k; k--) {
      const previous = this.words[i - 1]!
      this.words[i] = (this.words[i]! ^ Math.imul(previous ^ previous >>> 30, 1566083941)) - i
      if (++i >= 624) { this.words[0] = this.words[623]!; i = 1 }
    }
    this.words[0] = 0x80000000
  }
  state() { return [...this.words].map((word) => word.toString(16).padStart(8, '0')).join('') }
  next(): bigint {
    if (this.position === 624) {
      for (let i = 0; i < 624; i++) {
        const pair = this.words[i]! & 0x80000000 | this.words[(i + 1) % 624]! & 0x7fffffff
        this.words[i] = this.words[(i + 397) % 624]! ^ pair >>> 1 ^ (pair & 1 ? 0x9908b0df : 0)
      }
      this.position = 0
    }
    let word = this.words[this.position++]!
    word ^= word >>> 11; word ^= word << 7 & 0x9d2c5680
    word ^= word << 15 & 0xefc60000; word ^= word >>> 18
    return BigInt(word >>> 0)
  }
}
function seeded(seed: bigint) {
  const unsigned = BigInt.asUintN(64, seed)
  return new ReferenceMt([Number(unsigned & 0xffffffffn), Number(unsigned >> 32n)])
}
function entropyKeys(bytes: Uint8Array) {
  assert.equal(bytes.length, 32)
  return [...bytes].map((byte) => (byte | byte << 8 | bytes[1]! << 16 | byte << 24) >>> 0)
}
const entropy = (salt = 0) => Uint8Array.from({ length: 32 }, (_, i) => (0x80 + i * 7 + salt) & 255)
type Supply = (request: number, destination: number, length: number, module: NativeModule,
  production: ModuleOptions['randomBits']) => void
async function fixture(binary: boolean, supply: Supply) {
  let module!: NativeModule, calls = 0
  const intercepted: ModuleFactory = async (options) => {
    module = await factory({ ...options, randomBits: (destination, length) => {
      supply(++calls, destination, length, module, options.randomBits)
    } })
    return module
  }
  const vm = await TjsWasmRuntime.create(intercepted, () => { throw new Error('Entropy must not call the suspendable host') }, { wasmBinary, variant })
  return { vm, module, calls: () => calls,
    async run(source: string, expression = false) {
      return vm.execute(binary ? await vm.compile(source, 'random.tjs', expression) : source, 'random.tjs', expression)
    },
    async close() {
      await vm.dispose()
      assert.equal(Number(module._krkr_native_lifetime_stat!(4)), 0, 'No live native dispatch objects survive disposal')
    },
  }
}
async function using(binary: boolean, supply: Supply,
  body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary, supply), errors: unknown[] = []
  try { await body(f) } catch (error) { errors.push(error) }
  try { await f.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'RandomGenerator regression and cleanup failed')
}
function controlled(bytes = entropy()): Supply {
  return (request, destination, length, module) => {
    assert.equal(length, 16)
    module.HEAPU8.set(bytes.subarray((request - 1) % 2 * 16, (request - 1) % 2 * 16 + 16), destination)
  }
}

test('independent MT oracle agrees with the published array-seed vector and the manifest advertises native entropy', () => {
  assert.equal(manifest.capabilities?.nativeRandom, 1)
  const mt = new ReferenceMt([0x123, 0x234, 0x345, 0x456])
  assert.deepEqual(Array.from({ length: 10 }, () => mt.next()), [
    1067595299n, 955945823n, 477289528n, 4107218783n, 4228976476n,
    3344332714n, 3355579695n, 227628506n, 810200273n, 2591290167n,
  ])
})

test('direct runtime rejects a missing or wrong native entropy export before VM construction', { timeout: 60000 }, async () => {
  for (const version of [undefined, 0, 2]) {
    let created = false
    const altered: ModuleFactory = async (options) => {
      const module = await factory(options)
      if (version === undefined) delete module._krkr_random_source_version
      else module._krkr_random_source_version = () => version
      module._krkr_create = () => { created = true; return 0 }
      return module
    }
    await assert.rejects(TjsWasmRuntime.create(altered, () => { throw new Error('Unexpected host') }, { wasmBinary, variant }),
      /missing native random entropy support/)
    assert.equal(created, false)
  }
})

for (const binary of [false, true]) {
  const mode = `${variant}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: simultaneous native runtimes keep separate entropy providers after either hook is installed and one VM is disposed`, { timeout: 60000 }, async () => {
    const first = await fixture(binary, controlled(entropy(19))), errors: unknown[] = []
    let second: Awaited<ReturnType<typeof fixture>> | undefined, firstClosed = false
    try {
      second = await fixture(binary, controlled(entropy(83)))
      assert.notEqual(first.module, second.module)
      assert.notEqual(first.module.HEAPU8.buffer, second.module.HEAPU8.buffer)
      await first.run('var generator=new Math.RandomGenerator();')
      await second.run('var generator=new Math.RandomGenerator();')
      assert.deepEqual([first.calls(), second.calls()], [2, 2])
      assert.equal(await first.run('generator.serialize().state', true), new ReferenceMt(entropyKeys(entropy(19))).state())
      assert.equal(await second.run('generator.serialize().state', true), new ReferenceMt(entropyKeys(entropy(83))).state())
      await second.run('generator.randomize();')
      assert.deepEqual([first.calls(), second.calls()], [2, 4])
      await first.run('generator.randomize();')
      assert.deepEqual([first.calls(), second.calls()], [4, 4])
      assert.equal(await first.run('generator.serialize().state', true), new ReferenceMt(entropyKeys(entropy(19))).state())
      assert.equal(await second.run('generator.serialize().state', true), new ReferenceMt(entropyKeys(entropy(83))).state())
      for (const f of [first, second]) {
        const ownership = f.vm.inspect()
        assert.deepEqual([ownership.handles, ownership.pendingHandles, ownership.weakOwners, ownership.objectIdentities], [0, 0, 0, 0])
        assert(ownership.scriptObjects > 0)
      }
      await first.close()
      firstClosed = true
      await second.run('generator.randomize();var another=new Math.RandomGenerator();')
      assert.deepEqual([first.calls(), second.calls()], [4, 8])
      const expected = new ReferenceMt(entropyKeys(entropy(83)))
      assert.equal(await second.run('generator.serialize().state', true), expected.state())
      assert.equal(await second.run('another.serialize().state', true), expected.state())
      assert.equal(await second.run('generator.random32()', true), expected.next())
      const ownership = second.vm.inspect()
      assert.deepEqual([ownership.handles, ownership.pendingHandles, ownership.weakOwners, ownership.objectIdentities], [0, 0, 0, 0])
      assert.equal(Number(first.module._krkr_native_lifetime_stat!(4)), 0)
    } catch (error) { errors.push(error) }
    try { if (!firstClosed) await first.close() } catch (error) { errors.push(error) }
    try { await second?.close() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Simultaneous random runtimes or cleanup failed')
  })

  test(`${mode}: default native RandomGenerator obtains two 16-byte seeds and follows the complete original MT state`, { timeout: 60000 }, async () => {
    await using(binary, controlled(), async (f) => {
      await f.run('var generator=new Math.RandomGenerator();')
      assert.equal(f.calls(), 2)
      assert.equal(await f.run('[generator instanceof "RandomGenerator",Math.RandomGenerator instanceof "Class"].join(",")', true), '1,1')
      const expected = new ReferenceMt(entropyKeys(entropy()))
      assert.equal(await f.run('generator.serialize().state', true), expected.state())
      assert.equal(await f.run('[generator.serialize().left,generator.serialize().next].join(",")', true), '1,0')
      assert.equal(await f.run('(function(){var values=[];for(var i=0;i<630;i++)values.add(generator.random32());return values.join(",");})()', true),
        Array.from({ length: 630 }, () => expected.next()).join(','))
      await f.run('generator.randomize();')
      assert.equal(f.calls(), 4)
      assert.equal(await f.run('generator.serialize().state', true), new ReferenceMt(entropyKeys(entropy())).state())
    })
  })

  test(`${mode}: explicit integer, string, void and restored seeds never request entropy`, { timeout: 60000 }, async () => {
    await using(binary, () => { throw new Error('Explicit seed requested entropy') }, async (f) => {
      for (const [source, seed] of [['0', 0n], ['1', 1n], ['-1', -1n], ['0x1234567887654321', 0x1234567887654321n], ['"123"', 123n], ['void', 0n]] as const) {
        await f.run(`var seededGenerator=new Math.RandomGenerator(${source});`)
        assert.equal(await f.run('seededGenerator.serialize().state', true), seeded(seed).state())
        assert.equal(await f.run('seededGenerator.random32()', true), seeded(seed).next())
      }
      await f.run('var evaluated=0;function extra(){evaluated++;return %[];}seededGenerator.randomize(1,extra());')
      assert.equal(await f.run('evaluated', true), 1n)
      assert.equal(await f.run('seededGenerator.random32()', true), seeded(1n).next())
      await f.run('seededGenerator.randomize(void);var saved=seededGenerator.serialize();saved.state=saved.state.toUpperCase();var restored=new Math.RandomGenerator(saved);')
      assert.equal(await f.run('restored.random32()', true), seeded(0n).next())
      await assert.rejects(f.run('new Math.RandomGenerator(null);'), /./)
      assert.equal(f.calls(), 0)
    })
  })

  test(`${mode}: discarded random results advance native state while discarded serialize leaves it intact`, { timeout: 60000 }, async () => {
    await using(binary, () => { throw new Error('Unexpected entropy') }, async (f) => {
      await f.run('var generator=new Math.RandomGenerator(0x1234567887654321);generator.serialize();generator.random32();generator.random63();generator.random64();generator.random();')
      const expected = seeded(0x1234567887654321n)
      for (let i = 0; i < 7; i++) expected.next()
      assert.equal(await f.run('generator.random32()', true), expected.next())
      const low63 = expected.next(), high63 = expected.next()
      assert.equal(await f.run('generator.random63()', true), (low63 | high63 << 32n) & 0x7fffffffffffffffn)
      const low64 = expected.next(), high64 = expected.next()
      assert.equal(await f.run('generator.random64()', true), BigInt.asIntN(64, low64 | high64 << 32n))
      const lowReal = expected.next(), highReal = expected.next()
      assert.equal(await f.run('generator.random()', true), Number((lowReal | highReal << 32n) & 0xfffffffffffffn) / 0x10000000000000)
      assert.equal(f.calls(), 0)
    })
  })

  test(`${mode}: failed entropy at either call preserves reseeded state and releases every failed constructor`, { timeout: 60000 }, async () => {
    let phase = 0, failAt = 1
    await using(binary, (_request, destination, length, module) => {
      assert.equal(length, 16)
      if (++phase === failAt) throw new Error('controlled entropy failure')
      module.HEAPU8.fill(0xa5, destination, destination + length)
    }, async (f) => {
      await f.run('var generator=new Math.RandomGenerator(17);function constructFailure(){new Math.RandomGenerator();}function seedFailure(){generator.randomize();}')
      for (failAt of [1, 2]) {
        phase = 0
        await assert.rejects(f.run('constructFailure();'), /RandomGenerator entropy source failed/)
        await f.vm.collect()
        const before = f.vm.inspect().scriptObjects
        for (let attempt = 0; attempt < 12; attempt++) {
          phase = 0
          await assert.rejects(f.run('constructFailure();'), /RandomGenerator entropy source failed/)
        }
        await f.vm.collect()
        assert.equal(f.vm.inspect().scriptObjects, before)
        await f.run('generator.randomize(17);')
        phase = 0
        await assert.rejects(f.run('seedFailure();'), /RandomGenerator entropy source failed/)
        assert.equal(await f.run('generator.random32()', true), seeded(17n).next())
      }
      assert.equal(f.vm.inspect().handles, 0)
    })
  })

  test(`${mode}: serialized cursors accept the safe domain and reject out-of-bounds restores before replacing the old state`, { timeout: 60000 }, async () => {
    await using(binary, () => { throw new Error('Restore requested entropy') }, async (f) => {
      await f.run('var generator=new Math.RandomGenerator(29),snapshot=generator.serialize();')
      for (const [left, next] of [[0, 0], [-1, 0], [625, 0], [1, -1], [1, 625], [2, 624], [624, 2]]) {
        await f.run(`generator.randomize(29);snapshot.left=${left};snapshot.next=${next};`)
        await assert.rejects(f.run('generator.randomize(snapshot);'), /./)
        assert.equal(await f.run('generator.random32()', true), seeded(29n).next())
      }
      await f.run('snapshot.left=2;snapshot.next=0;generator.randomize(snapshot);')
      assert.equal(await f.run('generator.random32()', true), 0x88102204n, 'Unusual but safe state reads and tempers state[0]=0x80000000')
      await f.run('snapshot.left=0x100000001;snapshot.next=0x100000270;generator.randomize(snapshot);')
      assert.equal(await f.run('generator.random32()', true), seeded(29n).next(), 'Native int32 narrowing precedes range checks; left=1 refills before next=624 is read')
      for (const draws of [0, 1, 623, 624, 625]) {
        await f.run(`generator.randomize(29);for(var i=0;i<${draws};i++)generator.random32();var restored=new Math.RandomGenerator(generator.serialize());`)
        assert.equal(await f.run('restored.random64()==generator.random64()', true), 1n)
      }
      for (const state of ['short', 'g' + '0'.repeat(4991)]) {
        await f.run(`generator.randomize(29);var damaged=%[state:${JSON.stringify(state)},left:1,next:0];`)
        await assert.rejects(f.run('generator.randomize(damaged);'), /./)
        assert.equal(await f.run('generator.random32()', true), seeded(29n).next())
      }
      await f.run(`
var restoreTrace="",failedMember="";
class RestoreGetter {
 property state {getter(){global.restoreTrace+="state,";if(global.failedMember=="state")throw new Exception("state-fault");return global.snapshot.state;}}
 property left {getter(){global.restoreTrace+="left,";if(global.failedMember=="left")throw new Exception("left-fault");return 1;}}
 property next {getter(){global.restoreTrace+="next,";throw new Exception("next-fault");}}
}
var getters=new RestoreGetter();`)
      for (const [member, trace] of [['state', 'state,'], ['left', 'state,left,'], ['next', 'state,left,next,']]) {
        await f.run(`generator.randomize(29);restoreTrace="";failedMember=${JSON.stringify(member)};`)
        await assert.rejects(f.run('generator.randomize(getters);'), /./)
        assert.equal(await f.run('restoreTrace', true), trace)
        assert.equal(await f.run('generator.random32()', true), seeded(29n).next())
      }
      assert.equal(f.calls(), 0)
    })
  })

  test(`${mode}: production entropy rejects missing or throwing crypto and copies only a private 16-byte buffer`, { timeout: 60000 }, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), retained: Uint8Array[] = []
    try {
      await using(binary, (_request, destination, length, _module, production) => production(destination, length), async (f) => {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
        await assert.rejects(f.run('new Math.RandomGenerator();'), /RandomGenerator entropy source failed/)
        await f.run('var explicit=new Math.RandomGenerator(7);')
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(bytes: Uint8Array) {
          assert.equal(bytes.length, 16); bytes.fill(0xff); throw new Error('partial provider failure')
        } } })
        await assert.rejects(f.run('explicit.randomize();'), /RandomGenerator entropy source failed/)
        assert.equal(await f.run('explicit.random32()', true), seeded(7n).next())
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(bytes: Uint8Array) {
          assert.equal(bytes.length, 16)
          bytes.set(entropy().subarray(retained.length * 16, retained.length * 16 + 16))
          retained.push(bytes); return bytes
        } } })
        await f.run('var recovered=new Math.RandomGenerator();')
        assert.equal(retained.length, 2)
        assert.notEqual(retained[0]!.buffer, f.module.HEAPU8.buffer)
        assert.notEqual(retained[1]!.buffer, f.module.HEAPU8.buffer)
        retained.forEach((bytes) => bytes.fill(0))
        assert.equal(await f.run('recovered.random32()', true), new ReferenceMt(entropyKeys(entropy())).next())
      })
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
      else Reflect.deleteProperty(globalThis, 'crypto')
    }
  })
}
