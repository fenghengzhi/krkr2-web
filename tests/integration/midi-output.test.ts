import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { AudioClock } from '../helpers/audio.ts'
import { midiOutputSource } from '../helpers/midi-output.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import type { AudioCommand, AudioResult, MidiOutputMessage } from '../../src/engine/ports/audio.ts'

class ObservedAudio extends HeadlessAudioBackend {
  readonly delivered: { at: number; message: MidiOutputMessage }[] = []
  constructor(private readonly observedClock: AudioClock) {
    super({ now: () => observedClock.now, schedule: observedClock.schedule })
  }
  override async command(command: AudioCommand): Promise<AudioResult> {
    const result = await super.command(command)
    if (command.op === 'midiMessage') this.delivered.push({ at: this.observedClock.now,
      message: command.message.kind === 'long'
        ? { kind: 'long', data: command.message.data.slice() }
        : { ...command.message, data: [...command.message.data] } })
    return result
  }
}
async function setup(binary: boolean) {
  const clock = new AudioClock(), audio = new ObservedAudio(clock),
    f = await headless({ 'midi-output.tjs': midiOutputSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("midi-output.tjs","savedata/midi-output.cjs",false,true,false);Scripts.execStorage("savedata/midi-output.cjs");'
      : 'Scripts.execStorage("midi-output.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  return { ...f, clock, audio }
}
async function using(binary: boolean, body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(binary), failures: unknown[] = []
  try { await f.session.start(); await body(f) } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.clock.tasks.size, 0)
    assert.equal(f.session.snapshot().handles, 0)
    assert.equal(f.audio.mixer.hasClockWork, false)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'MIDI output and cleanup failed', { cause: failures[0] })
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('MIDI did not reach the controlled delay boundary')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

for (const binary of [false, true]) {
  const label = binary ? 'bytecode' : 'source'
  test(`${label}: actual MIDI octet method preserves class/instance conversion, partial audio and current native errors`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session, clock, audio }) => {
      await session.evaluate('(System.assignMessage("TVPMalformedMIDIMessage","raw-first:%1:%%"),System.assignMessage("TJSVariantConvertError","raw-convert:%2"))')
      assert.equal(await session.evaluate('midiOutputBasics()'), 'ready')
      assert.deepEqual(audio.delivered.map(({ message }) => message), [
        { kind: 'short', status: 0xc0, data: [5] }, { kind: 'short', status: 0xd0, data: [32] },
        { kind: 'short', status: 0xf1, data: [24] }, { kind: 'short', status: 0xf1, data: [25] },
        { kind: 'short', status: 0xf2, data: [1, 2] }, { kind: 'short', status: 0xf3, data: [3] },
        { kind: 'short', status: 0xf6, data: [] }, { kind: 'short', status: 0xf8, data: [] },
        { kind: 'short', status: 0xb0, data: [7, 127] }, { kind: 'short', status: 0xb0, data: [10, 64] },
        { kind: 'short', status: 0xb0, data: [11, 127] },
      ])
      assert.equal(await session.evaluate('midiExtraEvaluated'), '1')
      const missing = await session.evaluate('midiOutputMissing()')
      assert.notEqual(missing, 'unexpected-success'); assert.notEqual(missing, 'raw-first:%1:%%')
      for (const source of ['123', '"abc"', 'null', '[]', '%[]'])
        assert.equal(await session.evaluate(`midiOutputWrongType(${source})`), 'raw-convert:octet')
      assert.equal(audio.delivered.length, 11, 'invalid conversion must not reach the audio backend')
      assert.equal(await session.evaluate('midiOutputMalformedRunning()'), 'raw-first:%1:%%')
      await session.evaluate('System.assignMessage("TVPMalformedMIDIMessage","raw-second:%s:%1:%%")')
      assert.equal(await session.evaluate('midiOutputPartial()'), 'raw-second:%s:%1:%%')
      assert.deepEqual(audio.delivered.at(-1)!.message, { kind: 'short', status: 0x90, data: [69, 100] })
      clock.advance(40); await session.idle()
      assert(audio.mixer.peak > 0.001, 'a later malformed suffix must not roll back the already emitted note')
      assert.equal(await session.evaluate('midiOutputSilence()'), 'silent')
      assert.equal(audio.mixer.hasClockWork, false)
      // It is the original outer native method, not an instance-state method.
      assert.equal(await session.evaluate('(function(){var fn=midiOutputBuffer.midiOut;invalidate midiOutputBuffer;fn(<% c0 02 %>);return "borrowed";})()'), 'borrowed')
      assert.deepEqual(audio.delivered.at(-1)!.message, { kind: 'short', status: 0xc0, data: [2] })
      assert.equal(await session.evaluate('(function(){var result=MIDISoundBuffer.midiOut(<% f8 %>);return result===void;})()'), '1')
    })
  })

  test(`${label}: raw FF00 crosses separate native calls at 50ms and Stop cancels the owned wait`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session, clock, audio }) => {
      const before = new Set(clock.tasks), completed = session.evaluate('midiOutputDelayPair()')
      const observed = completed.then((value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }))
      await until(() => [...clock.tasks].some((task) => !before.has(task) && task.at === 50))
      assert.deepEqual(audio.delivered, [{ at: 0, message: { kind: 'short', status: 0xb0, data: [7, 127] } }])
      clock.advance(49); await Promise.resolve()
      assert.equal(audio.delivered.length, 1)
      clock.advance(1)
      assert.deepEqual(await observed, { status: 'fulfilled', value: 'delivered' })
      assert.deepEqual(audio.delivered[1], { at: 50, message: { kind: 'short', status: 0x90, data: [69, 100] } })
      clock.advance(20); await session.idle(); assert(audio.mixer.peak > 0.001)
      await session.evaluate('midiOutputSilence()')
      const waitingAt = clock.now + 50, previous = new Set(clock.tasks), count = audio.delivered.length,
        pending = session.evaluate('midiOutputDelayPair()').then(
          (value) => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
      await until(() => [...clock.tasks].some((task) => !previous.has(task) && task.at === waitingAt))
      await session.stop()
      const outcome = await pending
      assert.equal(outcome.status, 'rejected')
      if (outcome.status === 'rejected') assert.match(String(outcome.reason), /Execution cancelled/)
      assert.equal(audio.delivered.length, count + 1, 'only the anchor preceding FF00 was emitted')
      assert.equal(clock.tasks.size, 0)
      clock.advance(100); assert.equal(audio.delivered.length, count + 1)
    })
  })
}
