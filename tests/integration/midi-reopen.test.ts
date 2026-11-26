import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { midiReopenExpected, midiReopenFile, midiReopenFiles, midiReopenSource } from '../helpers/midi-reopen.ts'

// Independent sequencer objects keep their phase across the failed file lookup;
// authored per-sample CC7 levels follow the 60 ms native fade lattice.
function reference(key: number, levels: number[]): number[] {
  const synth = new MidiSynth(decodeMidi(midiReopenFile(key)))
  let position = 0
  return levels.map((level) => {
    synth.setBufferVolume(level); synth.render(position / 44100, (44100 / 1000) / 44100)
    position += 44100 / 1000
    return Math.fround(synth.left)
  })
}

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: missing MIDI replacement preserves real music and fade while opened invalid SMF retires the old notes`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { left.push(...l); right.push(...r) }, 1000),
      { session } = await headless({ ...midiReopenFiles(), 'reopen.tjs': midiReopenSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("reopen.tjs","savedata/reopen.cjs",false,true,false);Scripts.execStorage("savedata/reopen.cjs");'
          : 'Scripts.execStorage("reopen.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
    try {
      await session.start()
      for (const [kind, expected] of Object.entries(midiReopenExpected))
        assert.equal(await session.evaluate(`midiReopenObserve(${JSON.stringify(kind)})`), expected)
      assert.equal(audio.inspect().voices, 0)
      assert.equal(await session.evaluate('midiReopenStart()'), 'play')
      await session.evaluate('(reopenMusic.fade(0,120),0)')
      clock.advance(20); await session.idle()
      assert.deepEqual(left, reference(69, Array(20).fill(127)))
      assert.equal(await session.evaluate('midiReopenAttempt("midi-missing.mid")'), 'rejected:play')
      assert.equal(await session.evaluate('reopenMusic.volume+":"+reopenMusic.completed.count+":"+reopenMusic.states.join(",")'), '100000:0:stop,play')
      assert.equal(audio.inspect().fadingVoices, 1)
      clock.advance(40); await session.idle()
      assert.deepEqual(left, reference(69, [...Array(59).fill(127), 63]))
      assert.equal(await session.evaluate('midiReopenAttempt("midi-next.mid")'), 'opened:stop')
      assert.equal(await session.evaluate('reopenMusic.volume+":"+reopenMusic.completed.count+":"+reopenMusic.states.join(",")'), '50000:0:stop,play,stop')
      await session.evaluate('(reopenMusic.play(),0)')
      clock.advance(60); await session.idle()
      assert.deepEqual(left, [...reference(69, [...Array(59).fill(127), 63]), ...reference(81, [...Array(59).fill(63), 0])])
      assert.deepEqual(right, left)
      assert.equal(await session.evaluate('reopenMusic.volume+":"+reopenMusic.completed.join(",")'), '0:0')
      await session.evaluate('(reopenMusic.volume=100000,reopenMusic.fade(0,120),0)')
      assert.equal(await session.evaluate('midiReopenAttempt("midi-bad.mid")'), 'rejected:unload')
      assert.equal(audio.inspect().fadingVoices, 1)
      left.length = right.length = 0; clock.advance(120); await session.idle()
      assert.deepEqual(left, Array(120).fill(0)); assert.deepEqual(right, left)
      assert.equal(await session.evaluate('reopenMusic.completed.join(",")'), '0,0')
      assert.equal(await session.evaluate('(reopenMusic.open("midi-old.mid"),reopenMusic.play(),reopenMusic.volume)'), '0')
      left.length = right.length = 0; clock.advance(20); await session.idle()
      assert.deepEqual(left, Array(20).fill(0)); assert.deepEqual(right, left)
      await session.evaluate(`Scripts.exec(${JSON.stringify('global.reopenOnce=true;reopenMusic.onStatusChanged=function(value){if(value=="stop" && global.reopenOnce){global.reopenOnce=false;global.reopenMusic.open("midi-old.mid");}};reopenMusic.volume=100000;reopenMusic.open("midi-next.mid");reopenMusic.play();')})`)
      left.length = right.length = 0; clock.advance(20); await session.idle()
      assert.deepEqual(left, reference(81, Array(20).fill(127)), 'Outer Open retains its selected stream across reentrant Stop callbacks')
      assert.deepEqual(right, left)
      await session.evaluate('invalidate reopenMusic')
      assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI replacement or cleanup failed', { cause: failures[0] })
  })

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: a held MIDI read keeps fade control alive and Stop retires its waiter before late file completion`, { timeout: 60000 }, async (t) => {
    const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { resolve, promise } },
      gates = [gate(), gate()], entered = [gate(), gate()], clock = new AudioClock(), output: number[] = [], failures: unknown[] = [], pending: Promise<unknown>[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(...left), 1000),
      { session } = await headless({ ...midiReopenFiles(), 'reopen.tjs': midiReopenSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("reopen.tjs","savedata/reopen.cjs",false,true,false);Scripts.execStorage("savedata/reopen.cjs");'
          : 'Scripts.execStorage("reopen.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }), bytes = midiReopenFile(81)
    const observed = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new Error('MIDI fixture observation cancelled'))
      if (t.signal.aborted) cancel(); else t.signal.addEventListener('abort', cancel, { once: true })
      work.then((value) => { t.signal.removeEventListener('abort', cancel); resolve(value) },
        (error) => { t.signal.removeEventListener('abort', cancel); reject(error) })
    })
    session.mount(['held.mid', 'cancel.mid'].map((name, index) => ({ name, size: bytes.length,
      read: async () => { entered[index]!.resolve(); await gates[index]!.promise; return bytes.slice() } })))
    try {
      await session.start(); await session.evaluate('(midiReopenStart(),reopenMusic.fade(0,120),0)')
      clock.advance(20); await session.idle(); output.length = 0
      const opening = session.evaluate('reopenMusic.open("held.mid")'); pending.push(opening); void opening.catch(() => {})
      await observed(Promise.race([entered[0]!.promise, opening.then(() => { throw new Error('MIDI open did not reach its real file gate') })]))
      assert.equal(audio.inspect().fadingVoices, 1)
      clock.advance(120)
      assert.equal(audio.inspect().fadingVoices, 0); assert.deepEqual(output, Array(120).fill(0))
      gates[0]!.resolve(); await opening; await session.idle()
      assert.equal(await session.evaluate('reopenMusic.status+":"+reopenMusic.volume+":"+reopenMusic.completed.count'), 'stop:0:1')
      await session.evaluate('(reopenMusic.play(),reopenMusic.volume=100000,reopenMusic.fade(0,120),0)')
      const cancelled = session.evaluate('reopenMusic.open("cancel.mid")'); pending.push(cancelled); void cancelled.catch(() => {})
      await observed(Promise.race([entered[1]!.promise, cancelled.then(() => { throw new Error('MIDI cancel did not reach its real file gate') })]))
      const rejected = assert.rejects(cancelled, /cancel|closed|expired/i)
      await observed(session.stop()); await rejected
      assert.equal(audio.inspect().voices, 0); assert.equal(audio.inspect().pendingCreates, 0)
      gates[1]!.resolve()
    } catch (error) { failures.push(error) }
    for (const item of gates) item.resolve()
    for (const work of pending) await work.catch(() => {})
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Held MIDI replacement or cleanup failed', { cause: failures[0] })
  })
