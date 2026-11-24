import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MidiOutputExecutor, midiOutputSteps } from '../../src/engine/media/midi-output.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import type { MidiOutputMessage } from '../../src/engine/ports/audio.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { AudioClock } from '../helpers/audio.ts'

const bytes = (...values: number[]) => Uint8Array.from(values)
const malformed = (error: unknown) => error instanceof TvpError &&
  error.tvpMessage.id === 'TVPMalformedMIDIMessage' && error.tvpMessage.args.length === 0
async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) { if (predicate()) return; await Promise.resolve() }
  assert.fail('MIDI operation did not reach its observed boundary')
}

test('raw MIDI consumes native system operands and running status without validating their high bits', () => {
  assert.deepEqual([...midiOutputSteps(bytes(0xc0, 5, 6, 0xd0, 128, 0xf1, 24, 25, 0xf2, 1, 2,
    0xf3, 3, 0xf6, 0xf8, 0xf7, 0xff, 1, 0xff, 0, 0x90, 255, 129))], [
    { kind: 'short', status: 0xc0, data: [5] }, { kind: 'short', status: 0xc0, data: [6] },
    { kind: 'short', status: 0xd0, data: [128] }, { kind: 'short', status: 0xf1, data: [24] },
    { kind: 'short', status: 0xf1, data: [25] }, { kind: 'short', status: 0xf2, data: [1, 2] },
    { kind: 'short', status: 0xf3, data: [3] }, { kind: 'short', status: 0xf6, data: [] },
    { kind: 'short', status: 0xf8, data: [] }, { kind: 'delay' },
    { kind: 'short', status: 0x90, data: [255, 129] },
  ])
  const source = bytes(0xf0, 1, 0xf7, 2, 0xf7), messages = [...midiOutputSteps(source)]
  source.fill(0)
  assert.deepEqual(messages, [{ kind: 'long', data: bytes(0xf0, 1, 0xf7) },
    { kind: 'long', data: bytes(0xf7, 2, 0xf7) }], 'running F0 preserves the original memcpy start')
  assert.throws(() => [...midiOutputSteps(bytes(0xf8, 1))], /no forward progress/)
})

test('raw MIDI yields a completed prefix before malformed data and resets running status per call', async () => {
  const clock = new AudioClock(), sent: MidiOutputMessage[] = [],
    output = new MidiOutputExecutor({ now: () => clock.now, schedule: clock.schedule }, async (message) => { sent.push(message) })
  try {
    await assert.rejects(output.send(bytes(0x90, 69, 100, 0x80, 69)), malformed)
    assert.deepEqual(sent, [{ kind: 'short', status: 0x90, data: [69, 100] }])
    await assert.rejects(output.send(bytes(69, 0)), malformed)
    for (const invalid of [bytes(0xf1), bytes(0xf2, 1), bytes(0xf3), bytes(0xff), bytes(0xf0, 1)])
      await assert.rejects(output.send(invalid), malformed)
    assert.equal(sent.length, 1)
    await output.send(bytes(0x80, 69, 0))
    assert.deepEqual(sent[1], { kind: 'short', status: 0x80, data: [69, 0] })
    assert.deepEqual(output.inspect(), { pending: 0, bytes: 0, waiting: 0 })
  } finally { output.cancel() }
})

test('FF00 defers the next actual output for exactly 50 host milliseconds across raw calls', async () => {
  const clock = new AudioClock(), sent: { at: number; message: MidiOutputMessage }[] = [],
    output = new MidiOutputExecutor({ now: () => clock.now, schedule: clock.schedule }, async (message) => { sent.push({ at: clock.now, message }) })
  let delayed: Promise<void> | undefined
  try {
    await output.send(bytes(0xff, 0))
    assert.equal(clock.tasks.size, 0, 'the delay opcode itself must return without sleeping')
    clock.advance(20); await output.send(bytes(0xff, 0))
    await assert.rejects(output.send(bytes(0x90, 60)), malformed)
    assert.equal(clock.tasks.size, 0, 'parsing a malformed message does not consume the pending delay')
    delayed = output.send(bytes(0x90, 69, 100))
    await until(() => output.inspect().waiting === 1)
    clock.advance(49); await Promise.resolve(); assert.equal(sent.length, 0)
    clock.advance(1); await delayed
    assert.deepEqual(sent, [{ at: 70, message: { kind: 'short', status: 0x90, data: [69, 100] } }])
    await output.send(bytes(0x80, 69, 0))
    assert.equal(sent[1]!.at, 70, 'a consumed delay must not affect the next call')
    assert.equal(clock.tasks.size, 0)
  } finally { output.cancel(); await delayed?.catch(() => {}) }
})

test('raw call snapshots stay FIFO through suspension and an output rejection preserves its identity', async () => {
  const clock = new AudioClock(), sent: MidiOutputMessage[] = [], failure = new Error('actual backend failure')
  let release!: () => void, first = true
  const hold = new Promise<void>((resolve) => { release = resolve }),
    output = new MidiOutputExecutor({ now: () => clock.now, schedule: clock.schedule }, async (message) => {
      sent.push(message)
      if (first) { first = false; await hold; throw failure }
    })
  const a = output.send(bytes(0xc0, 1)), aFailure = assert.rejects(a, (error) => error === failure),
    mutable = bytes(0xc0, 2), b = output.send(mutable)
  mutable[1] = 99
  try {
    await until(() => sent.length === 1)
    assert.equal(output.inspect().pending, 2)
    release(); await aFailure; await b
    assert.deepEqual(sent, [{ kind: 'short', status: 0xc0, data: [1] }, { kind: 'short', status: 0xc0, data: [2] }])
    assert.deepEqual(output.inspect(), { pending: 0, bytes: 0, waiting: 0 })
  } finally { release(); output.cancel(); await Promise.allSettled([a, b]) }
})

test('raw pending budgets are reserved before queuing and Stop releases delays without replacing its cause', async () => {
  const clock = new AudioClock(), cancelled = new Error('controlled Stop'), sent: MidiOutputMessage[] = [],
    output = new MidiOutputExecutor({ now: () => clock.now, schedule: clock.schedule }, async (message) => { sent.push(message) })
  const operations: Promise<void>[] = []
  try {
    await output.send(bytes(0xff, 0))
    for (let i = 0; i < 64; i++) operations.push(output.send(bytes(0xc0, i)))
    const settled = Promise.allSettled(operations)
    await assert.rejects(output.send(bytes(0xc0, 65)), /pending octet budget/)
    await until(() => output.inspect().waiting === 1)
    output.cancel(cancelled); output.cancel(new Error('late Stop'))
    for (const result of await settled) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.equal(result.reason, cancelled)
    }
    assert.equal(clock.tasks.size, 0); clock.advance(100); assert.equal(sent.length, 0)
    assert.deepEqual(output.inspect(), { pending: 0, bytes: 0, waiting: 0 })
    await assert.rejects(output.send(bytes(0xc0, 1)), (error) => error === cancelled)
  } finally { output.cancel(); await Promise.allSettled(operations) }
  const large = new MidiOutputExecutor({ now: () => 0, schedule: clock.schedule }, async () => {})
  try {
    await assert.rejects(large.send(new Uint8Array(16 * 1024 * 1024 + 1)), /pending octet budget/)
    assert.deepEqual(large.inspect(), { pending: 0, bytes: 0, waiting: 0 })
  } finally { large.cancel() }
  const cleanup = new Error('synchronous clock cancellation'), synchronous = new MidiOutputExecutor({
    now: () => clock.now,
    schedule(callback, delay) { clock.now += delay; callback(); return () => { throw cleanup } },
  }, async () => { assert.fail('Failed timer retirement must not emit output') })
  try {
    await synchronous.send(bytes(0xff, 0))
    await assert.rejects(synchronous.send(bytes(0xc0, 1)), (error) => error === cleanup)
    assert.deepEqual(synchronous.inspect(), { pending: 0, bytes: 0, waiting: 0 })
  } finally { synchronous.cancel() }
})

test('actual mixer output keeps raw-prefix notes audible and schedules FF00 before its next samples', () => {
  const mixer = new AudioMixer(1000), render = (count: number) => {
    const left = new Float32Array(count), right = new Float32Array(count)
    mixer.render(left, right); return left
  }
  mixer.command({ op: 'midiOut', data: bytes(0xff, 0) })
  assert.equal(mixer.hasClockWork, false)
  mixer.command({ op: 'midiOut', data: bytes(0x90, 69, 100) })
  assert.equal(mixer.hasClockWork, true)
  assert(render(50).every((sample) => sample === 0))
  assert(render(20).some((sample) => Math.abs(sample) > 0.001))
  mixer.command({ op: 'midiMessage', message: { kind: 'long', data: bytes(0xf0, 0x7e, 0x7f, 9, 1, 0xf7) } })
  assert(render(20).every((sample) => sample === 0))
  assert.throws(() => mixer.command({ op: 'midiOut', data: bytes(0x90, 69, 100, 0xf2, 1) }), malformed)
  assert(render(20).some((sample) => Math.abs(sample) > 0.001))
  mixer.command({ op: 'shutdown' }); assert.equal(mixer.hasClockWork, false)
  const repeated = new AudioMixer(1000), sample = (count: number) => {
    const left = new Float32Array(count), right = new Float32Array(count)
    repeated.render(left, right); return left
  }
  repeated.command({ op: 'midiOut', data: bytes(0xff, 0, 0x90, 69, 100, 0xff, 0, 0xb0, 120, 0) })
  assert(sample(50).every((value) => value === 0))
  assert(sample(50).some((value) => Math.abs(value) > 0.001), 'the second FF00 starts after the first delayed packet')
  assert(sample(20).every((value) => value === 0))
  assert.equal(repeated.hasClockWork, false)
})

test('native MIDI octet support is required before creating a VM and the unchanged kernel recovers', { timeout: 60000 }, async () => {
  const variant = process.env.KRKR_MIDI_VARIANT ?? 'asyncify'
  assert(variant === 'asyncify' || variant === 'jspi')
  const directory = resolve('.generated/wasm'),
    manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest,
    assets = manifest.variants[variant]!,
    { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory },
    wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
  assert.equal(manifest.capabilities?.nativeMidi, 1)
  for (const version of [undefined, 0, 2, 'setter'] as const) {
    let created = false
    const altered: ModuleFactory = async (options) => {
      const module = await factory(options)
      if (version === undefined) delete module._krkr_native_midi_version
      else if (version === 'setter') delete module._krkr_value_set_midi_out_function
      else module._krkr_native_midi_version = () => version
      module._krkr_create = () => { created = true; return 0 }
      return module
    }
    await assert.rejects(TjsWasmRuntime.create(altered, () => { throw new Error('Unexpected host') }, { wasmBinary, variant }), /missing native MIDI output support/)
    assert.equal(created, false)
  }
  const vm = await TjsWasmRuntime.create(factory, () => { throw new Error('Unexpected host') }, { wasmBinary, variant })
  try { assert.equal(await vm.execute('21*2', 'midi-capability.tjs', true), 42n) }
  finally { vm.dispose() }
})
