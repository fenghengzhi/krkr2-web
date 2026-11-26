import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { waveTailFiles, waveTailSource } from '../helpers/wave-tail.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function observed(signal: AbortSignal, work: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Game startup read was cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    work.then(() => { signal.removeEventListener('abort', abort); resolve() },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: the actual music handoff game prepares paused Wave playback before returning and starts its successor only once`, { timeout: 60000 }, async (t) => {
  const files = waveTailFiles(), bytes = files['tail-game.wav'], gate = deferred(), entered = deferred(), clock = new AudioClock(),
    output: number[][] = [[], []], failures: unknown[] = [], reads: number[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
      (left, right) => { output[0]!.push(...left); output[1]!.push(...right) }, 48000),
    { session } = await headless({ ...files, 'startup-range.wav.sli': files['tail-game.wav.sli'], 'tail.tjs': waveTailSource,
      'startup.tjs': binary ? 'Scripts.compileStorage("tail.tjs","savedata/tail.cjs",false,true,false);Scripts.execStorage("savedata/tail.cjs");'
        : 'Scripts.execStorage("tail.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  session.mount([{ name: 'startup-range.wav', size: bytes.length,
    read: async () => { throw new Error('Streaming game music must not be fully materialized') },
    source: { size: bytes.length, async read(offset, length) {
      reads.push(offset)
      if (offset === 44 + 8192 * 4) { entered.resolve(); await gate.promise }
      return bytes.slice(offset, offset + length)
    } } }])
  const take = async (left: number, right: number) => {
    output.forEach((plane) => { plane.length = 0 }); clock.advance(20); await session.idle()
    assert.deepEqual(output, [Array(960).fill(left), Array(960).fill(right)])
  }
  let pending: Promise<unknown> | undefined
  try {
    await session.start()
    pending = session.evaluate('waveTailStart("startup-range.wav",true)'); void pending.catch(() => {})
    await observed(t.signal, entered.promise)
    assert.equal(audio.mixer.snapshot(2).status, 'stop'); assert.equal(audio.mixer.snapshot(2).position, 0)
    clock.advance(100); assert.deepEqual(output, [[], []])
    gate.resolve(); assert.equal(await pending, 'play,stop,0')
    assert.equal(await session.evaluate('waveTailState()'), 'play,stop||0')
    for (const page of [8192, 12288, 16384, 20480]) assert(reads.includes(44 + page * 4))
    clock.advance(100); await session.idle(); assert.deepEqual(output, [[], []])
    await session.evaluate('(tailCurrent.paused=false,0)')
    // The first audible output follows play completion directly, with no
    // fixture-side page settling or replacement of the original game script.
    await take(.25, -.5)
    assert.equal(await session.evaluate('waveTailState()'), 'play,stop|head|0')
    for (let block = 1; block < 50; block++) { await settleAudioPages(audio); await take(.25, -.5) }
    await take(0, 0) // The native script callback now starts the separate voice.
    assert.equal(await session.evaluate('waveTailState()'), 'stop,play|head,tail,stop|1')
    await take(.5, .125)
    await session.evaluate('(waveTailManualStop(),tailCurrent.play(),0)')
    await take(.25, -.5)
    assert.equal(await session.evaluate('tailCount'), '1', 'Manual replay cannot synthesize another endpoint event')
    await session.evaluate('waveTailClose()'); assert.equal(audio.inspect().voices, 0)
  } catch (error) { failures.push(error) }
  gate.resolve()
  try { await pending } catch (error) { if (!failures.includes(error)) failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Game Wave startup preparation or cleanup failed', { cause: failures[0] })
})
