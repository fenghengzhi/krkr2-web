import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveReopenExpected, waveReopenFiles, waveReopenSource } from '../helpers/wave-reopen.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function observed<T>(signal: AbortSignal, event: Promise<T>, pending?: Promise<unknown>): Promise<T> {
  const value = pending ? Promise.race([event, pending.then(() => {
    throw new Error('Sound operation completed before its held source was reached')
  })]) : event
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Sound fixture was cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    value.then((result) => { signal.removeEventListener('abort', abort); resolve(result) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
const files = (binary: boolean) => ({ ...waveReopenFiles(), 'reopen-control.tjs': waveReopenSource,
  'startup.tjs': binary
    ? 'Scripts.compileStorage("reopen-control.tjs","savedata/reopen-control.cjs",false,true,false);Scripts.execStorage("savedata/reopen-control.cjs");'
    : 'Scripts.execStorage("reopen-control.tjs");' })

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: actual Wave reopen and failed open retain the inherited fade, exact PCM, labels and status callbacks`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
        left.push(...l); right.push(...r)
      }, 1000), { session } = await headless(files(binary), { audio, now: () => clock.now, schedule: clock.schedule })
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((entry) => entry.path === 'savedata/reopen-control.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      for (const [kind, expected] of Object.entries(waveReopenExpected))
        assert.equal(await session.evaluate(`waveReopenObserve("${kind}")`), expected, kind)
      assert.equal(audio.inspect().voices, 0)
      await session.evaluate('(function(){global.rw=new ReopenWave();rw.open("reopen-a.wav");global.beforeReopenLabels=rw.labels;rw.play();rw.fade(0,120);return 0;})()')
      await settleAudioPages(audio); clock.advance(20); await session.idle()
      assert.deepEqual(left, Array(20).fill(0.5))
      assert.equal(await session.evaluate('(rw.open("reopen-b.wav"),[rw.status,rw.volume,rw.completed.count,int(isvalid beforeReopenLabels),rw.states.join(",")].join("|"))'),
        'stop|100000|0|0|stop,play,stop,unload,stop')
      assert.equal(await session.evaluate('rw.labels["new"].samplePosition'), '10')
      await session.evaluate('(rw.play(),0)'); await settleAudioPages(audio)
      clock.advance(100); await session.idle()
      assert.deepEqual(left, [...Array(20).fill(0.5), ...Array(39).fill(0.25),
        ...Array(60).fill(Math.fround(0.25 * 10 ** (-1505 / 2000))), 0])
      assert.deepEqual(right, left)
      assert.equal(await session.evaluate('[rw.samplePosition,rw.volume,rw.completed.join(","),rw.labelsSeen.join(",")].join("|")'),
        '100|0|0|old,new')
      await session.evaluate('(rw.volume=100000,rw.fade(0,120),0)')
      assert.equal(await session.evaluate('(function(){try{rw.open("missing-reopen.wav");}catch(e){return rw.status+","+rw.completed.count;}return "unexpected";})()'), 'unload,1')
      assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
      left.length = right.length = 0
      clock.advance(120); await session.idle()
      assert.deepEqual(left, Array(120).fill(0)); assert.deepEqual(right, left)
      assert.equal(await session.evaluate('[rw.status,rw.volume,rw.completed.join(",")].join("|")'), 'unload|0|0,0')
      assert.equal(audio.inspect().fadingVoices, 0)
      await session.evaluate('(invalidate rw,0)')
      assert.equal(audio.inspect().voices, 0)
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave reopen or cleanup failed', { cause: failures[0] })
  })

  test(`${mode}: a real held Wave resource cannot freeze fade time, resurrect old volume or outlive Stop`, { timeout: 60000 }, async (t) => {
    const clock = new AudioClock(), output: number[] = [], failures: unknown[] = [],
      gates = [deferred(), deferred()], entered = [deferred(), deferred()],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(...left), 1000),
      { session } = await headless(files(binary), { audio, now: () => clock.now, schedule: clock.schedule }),
      bytes = waveReopenFiles()['reopen-b.wav'], pending: Promise<unknown>[] = []
    session.mount(['held-reopen.wav', 'cancel-reopen.wav'].map((name, index) => {
      let first = true
      return { name, size: bytes.length, read: async () => { throw new Error('A range source must not be fully read') },
        source: { size: bytes.length, async read(at: number, length: number) {
          if (first) { first = false; entered[index]!.resolve(); await gates[index]!.promise }
          return bytes.slice(at, at + length)
        } } }
    }))
    try {
      await session.start()
      await session.evaluate('(function(){global.rw=new ReopenWave();rw.open("reopen-a.wav");rw.play();rw.fade(0,120);return 0;})()')
      await settleAudioPages(audio); clock.advance(20); await session.idle()
      const opening = session.evaluate('rw.open("held-reopen.wav")')
      pending.push(opening); void opening.catch(() => {})
      await observed(t.signal, entered[0]!.promise, opening)
      assert.equal(audio.mixer.inspectStreams().voices, 0)
      assert.equal(audio.inspect().fadingVoices, 1)
      clock.advance(120)
      assert.equal(audio.inspect().fadingVoices, 0)
      assert.deepEqual(output, [...Array(20).fill(0.5), ...Array(120).fill(0)])
      gates[0]!.resolve(); await opening; await session.idle()
      assert.equal(await session.evaluate('[rw.status,rw.volume,rw.completed.count].join(",")'), 'stop,0,0',
        'Native SetStatus(stop) cancels the fade event queued while the open was pending')
      await session.evaluate('(rw.play(),0)'); await settleAudioPages(audio)
      output.length = 0; clock.advance(20); await session.idle()
      assert.deepEqual(output, Array(20).fill(0), 'Successful load must keep the fade target reached during source I/O')
      await session.evaluate('(rw.volume=100000,rw.fade(0,120),0)')
      const cancelled = session.evaluate('rw.open("cancel-reopen.wav")')
      pending.push(cancelled); void cancelled.catch(() => {})
      await observed(t.signal, entered[1]!.promise, cancelled)
      const rejected = assert.rejects(cancelled, /cancel|closed|expired/i)
      await observed(t.signal, session.stop()); await rejected
      assert.equal(audio.inspect().voices, 0); assert.equal(audio.inspect().pendingCreates, 0)
      gates[1]!.resolve()
    } catch (error) { failures.push(error) }
    for (const gate of gates) gate.resolve()
    for (const operation of pending) await operation.catch(() => {})
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Held Wave reopen or cleanup failed', { cause: failures[0] })
  })
}
