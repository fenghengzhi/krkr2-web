import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { cddaReopenDiscs, cddaReopenFiles, cddaReopenSource } from '../helpers/cdda-reopen.ts'

const files = (binary: boolean): Record<string, string | Uint8Array> => ({ ...cddaReopenFiles(), 'disc-control.tjs': cddaReopenSource,
  'startup.tjs': binary
    ? 'Scripts.compileStorage("disc-control.tjs","savedata/disc-control.cjs",false,true,false);Scripts.execStorage("savedata/disc-control.cjs");'
    : 'Scripts.execStorage("disc-control.tjs");' })
function gate() {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve: () => resolve() }
}
function observed<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('CDDA fixture observation cancelled'))
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
    work.then((value) => { signal.removeEventListener('abort', cancel); resolve(value) },
      (error) => { signal.removeEventListener('abort', cancel); reject(error) })
  })
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: same-disc and other-disc CUE tracks keep the audible fade and only its actual completion fires`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (left, right) => { output[0]!.push(...left); output[1]!.push(...right) }, 1000),
      { session } = await headless(files(binary), { audio, now: () => clock.now, schedule: clock.schedule,
        cddaDiscs: cddaReopenDiscs }),
      tick = async (ms: number) => { await settleAudioPages(audio); clock.advance(ms); await session.idle() }
    try {
      await session.start(); assert.equal(await session.evaluate('discReopenStart()'), 'play')
      await session.evaluate('(discMusic.fade(0,120),0)'); await tick(20)
      assert.deepEqual(output, [Array(20).fill(.5), Array(20).fill(-.25)])
      assert.equal(await session.evaluate('(discMusic.open("D:2"),discReopenState())'), 'stop|100000||stop,play,stop')
      await session.evaluate('(discMusic.play(),0)'); await tick(40)
      assert.equal(await session.evaluate('discMusic.volume+":"+discMusic.completed.count'), '50000:0')
      assert.equal(await session.evaluate('(discMusic.open("E:1"),discReopenState())'), 'stop|50000||stop,play,stop,play,stop,unload,stop')
      await session.evaluate('(discMusic.play(),0)'); await tick(60)
      assert.deepEqual(output[0], [...Array(20).fill(.5), ...Array(39).fill(.25), .125, ...Array(59).fill(-.25), 0])
      assert.deepEqual(output[1], [...Array(20).fill(-.25), ...Array(39).fill(-.125), -.0625, ...Array(59).fill(.125), 0])
      assert.equal(await session.evaluate('discMusic.status+":"+discMusic.volume+":"+discMusic.completed.join(",")'), 'play:0:0')
      await tick(20); assert.equal(await session.evaluate('discMusic.completed.count'), '1')

      // Manual stop retires playback, not the base sound fade. A later track
      // resumes at that fade's current volume and its original deadline.
      await session.evaluate('(discMusic.volume=100000,discMusic.fade(0,120),discMusic.stop(),0)')
      output.forEach((plane) => { plane.length = 0 }); await tick(60)
      assert.deepEqual(output, [Array(60).fill(0), Array(60).fill(0)])
      assert.equal(await session.evaluate('(discMusic.open("D:1"),discMusic.play(),discMusic.volume)'), '50000')
      output.forEach((plane) => { plane.length = 0 }); await tick(60)
      assert.deepEqual(output, [[...Array(59).fill(.25), 0], [...Array(59).fill(-.125), 0]])
      assert.equal(await session.evaluate('discMusic.completed.join(",")'), '0,0')

      await session.evaluate('(discMusic.volume=80000,discMusic.fade(20000,1000000000),0)')
      assert.equal(await session.evaluate('discReopenAttempt("D:99")'), 'opened:stop')
      assert.equal(audio.inspect().fadingVoices, 1)
      assert.equal(await session.evaluate('(function(){try{discMusic.play();}catch(error){return discMusic.status+":"+discMusic.completed.count;}return "unexpected";})()'), 'stop:2')
      assert.equal(await session.evaluate('(discMusic.open("D:2"),discMusic.stopFade(),discMusic.completed.join(","))'), '0,0,20000')

      // A bad encoded file fails after the old media was retired; it leaves
      // no old samples, but the inherited fade still completes in silence.
      await session.evaluate('(discMusic.play(),discMusic.volume=100000,discMusic.fade(0,120),0)')
      assert.equal(await session.evaluate('discReopenAttempt("F:1")'), 'rejected:unload')
      assert.equal(audio.inspect().fadingVoices, 1)
      output.forEach((plane) => { plane.length = 0 }); await tick(120)
      assert.deepEqual(output, [Array(120).fill(0), Array(120).fill(0)])
      assert.equal(await session.evaluate('discMusic.completed.join(",")'), '0,0,20000,0')

      // Native local drive/track variables survive a Stop callback that opens
      // a different drive. The outer selection must still become D:2.
      await session.evaluate('(discMusic.open("D:1"),discMusic.play(),discMusic.volume=80000,discMusic.fade(20000,1000000000),discMusic.replaceOnce=true,discMusic.open("D:2"),discMusic.play(),0)')
      assert.equal(await session.evaluate('discMusic.completed.count'), '4')
      output.forEach((plane) => { plane.length = 0 }); await tick(20)
      assert.deepEqual(output, [Array(20).fill(Math.fround(.2)), Array(20).fill(Math.fround(-.1))])
      assert.equal(await session.evaluate('(discMusic.stopFade(),discMusic.completed.join(","))'), '0,0,20000,0,20000')
      // Keep the existing Web direct-file route, including its full extent,
      // while the same SoundBuffer's fade continues through that replacement.
      assert.equal(await session.evaluate('(discMusic.fade(0,120),discMusic.open("a.wav"),discMusic.play(),discMusic.totalTime)'), '8000')
      output.forEach((plane) => { plane.length = 0 }); await tick(120)
      assert.deepEqual(output[0], [...Array(59).fill(Math.fround(.1)), ...Array(60).fill(Math.fround(.05)), 0])
      assert.deepEqual(output[1], [...Array(59).fill(Math.fround(-.05)), ...Array(60).fill(Math.fround(-.025)), 0])
      assert.equal(await session.evaluate('discMusic.completed.join(",")'), '0,0,20000,0,20000,0')
      assert.equal(await session.evaluate('(discMusic.open("D:99"),discMusic.fade(100000,120),discMusic.status)'), 'stop')
      output.forEach((plane) => { plane.length = 0 }); await tick(120)
      assert.deepEqual(output, [Array(120).fill(0), Array(120).fill(0)])
      assert.equal(await session.evaluate('discMusic.status+":"+discMusic.volume+":"+discMusic.completed.count'), 'stop:100000:7')
      await session.evaluate('invalidate discMusic')
      assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'CDDA replacement or cleanup failed', { cause: failures[0] })
  })

  test(`${mode}: a held same-disc decoder preserves fade completion and Stop cancels a later CUE read`, { timeout: 60000 }, async (t) => {
    const clock = new AudioClock(), output: number[] = [], failures: unknown[] = [], pending: Promise<unknown>[] = [],
      held = gate(), entered = gate(), cueHold = gate(), cueEntered = gate(), contents = files(binary),
      bytes = contents['held.wav'] as Uint8Array, cue = new TextEncoder().encode(contents['disc-a.cue'] as string),
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(...left), 1000),
      { session } = await headless(contents, { audio, now: () => clock.now, schedule: clock.schedule, cddaDiscs: cddaReopenDiscs })
    let first = true, suspendCue = false
    session.mount([
      { name: 'held.wav', size: bytes.length, async read() { throw new Error('Expected actual range decoding') },
        source: { size: bytes.length, async read(at: number, length: number) {
          if (first && at === 0 && length === 12) { first = false; entered.resolve(); await held.promise }
          return bytes.slice(at, at + length)
        } } },
      { name: 'disc-a.cue', size: cue.length, async read() {
        if (suspendCue) { cueEntered.resolve(); await cueHold.promise }
        return cue.slice()
      } },
    ])
    try {
      await session.start(); await session.evaluate('(discReopenStart(),discMusic.fade(0,120),0)')
      await settleAudioPages(audio); clock.advance(20); await session.idle()
      const opening = session.evaluate('discMusic.open("D:3")'); pending.push(opening); void opening.catch(() => {})
      await observed(t.signal, Promise.race([entered.promise, opening.then(() => { throw new Error('CDDA opening did not enter its decoder gate') })]))
      assert.equal(audio.inspect().pendingCreates, 1); assert.equal(audio.mixer.snapshot(1).status, 'stop')
      assert.equal(audio.mixer.inspectStreams().voices, 0)
      clock.advance(100)
      assert.equal(audio.inspect().fadingVoices, 0); assert.equal(audio.mixer.snapshot(1).status, 'stop')
      assert.deepEqual(output, [...Array(20).fill(.5), ...Array(100).fill(0)])
      held.resolve(); await opening; await session.idle()
      assert.equal(await session.evaluate('discReopenState()'), 'stop|0|0|stop,play,stop')
      await session.evaluate('(discMusic.play(),discMusic.volume=100000,discMusic.fade(0,120),0)')
      suspendCue = true
      const cancelled = session.evaluate('discMusic.open("D:4")'); pending.push(cancelled); void cancelled.catch(() => {})
      await observed(t.signal, Promise.race([cueEntered.promise, cancelled.then(() => { throw new Error('CDDA opening did not enter its CUE gate') })]))
      assert.equal(audio.inspect().pendingCreates, 0)
      assert.equal(audio.mixer.snapshot(1).status, 'play', 'Source selection precedes stopping the current track')
      output.length = 0; clock.advance(20)
      assert.deepEqual(output, Array(20).fill(.25))
      const rejected = assert.rejects(cancelled, /cancel|closed|expired/i)
      await observed(t.signal, session.stop()); await rejected
      assert.equal(audio.inspect().voices, 0); assert.equal(audio.inspect().pendingCreates, 0)
      cueHold.resolve()
    } catch (error) { failures.push(error) }
    held.resolve(); cueHold.resolve()
    for (const work of pending) await work.catch(() => {})
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Held CDDA replacement or cleanup failed', { cause: failures[0] })
  })
}
