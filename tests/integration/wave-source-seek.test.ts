import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, wave } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'

const source = String.raw`
System.exitOnNoWindowStartup=false;
class SeekRecording extends WaveSoundBuffer {
 var heard=[];
 function SeekRecording(){super.WaveSoundBuffer(null);}
 function onLabel(name){heard.add(name);}
}
var seekRecording=new SeekRecording();
function seekBegin(){seekRecording.open("recording.wav");seekRecording.play();return seekRecording.status;}
function seekMove(position){
 seekRecording.samplePosition=position;
 Debug.message("recording-target-ready:"+seekRecording.samplePosition);
 return [seekRecording.samplePosition,seekRecording.status,seekRecording.heard.count].join("|");
}
`
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function observed(signal: AbortSignal, work: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Recording seek observation was cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    work.then(() => { signal.removeEventListener('abort', abort); resolve() },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: a game seek marker follows real WAVE page delivery and its first audible label, pause and replay stay ordered`, { timeout: 60000 }, async (t) => {
  const bytes = wave(Array.from({ length: 40000 }, (_, at) => at < 16384 ? .25 : .5), 1000),
    clock = new AudioClock(), output: number[][] = [[], []], entered = deferred(), release = deferred(), failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
      (left, right) => { output[0]!.push(...left); output[1]!.push(...right) }, 1000),
    { session, logs } = await headless({ 'recording.tjs': source,
      'recording.wav.sli': "#2.00\nLabel { Position=16391; Name='destination'; }\n",
      'startup.tjs': binary ? 'Scripts.compileStorage("recording.tjs","savedata/recording.cjs",false,true,false);Scripts.execStorage("savedata/recording.cjs");'
        : 'Scripts.execStorage("recording.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  session.mount([{ name: 'recording.wav', size: bytes.length,
    read: async () => { throw new Error('The seekable recording must not be fully materialized') },
    source: { size: bytes.length, async read(offset, length) {
      if (offset === 44 + 16384 * 2) { entered.resolve(); await release.promise }
      return bytes.slice(offset, offset + length)
    } } }])
  const take = async (ms: number, expected: number[]) => {
    output.forEach((plane) => { plane.length = 0 }); clock.advance(ms); await session.idle()
    assert.deepEqual(output, [expected, expected])
  }
  let pending: Promise<unknown> | undefined
  try {
    await session.start(); assert.equal(await session.evaluate('seekBegin()'), 'play')
    await take(20, Array(20).fill(.25))
    pending = session.evaluate('seekMove(16391)'); void pending.catch(() => {})
    await observed(t.signal, entered.promise)
    assert(!logs.some((line) => line.startsWith('recording-target-ready:')))
    assert.equal(audio.mixer.snapshot(1).position, 20)
    output.forEach((plane) => { plane.length = 0 }); clock.advance(20)
    assert.deepEqual(output, [Array(20).fill(.25), Array(20).fill(.25)], 'Waiting for the target does not silence current music')
    release.resolve(); assert.equal(await pending, '16391|play|0')
    assert(logs.includes('recording-target-ready:16391'))
    // No helper prefetch wait here: completion itself guarantees the target.
    await take(20, Array(20).fill(.5))
    assert.equal(await session.evaluate('seekRecording.heard.join(",")'), 'destination')
    assert.equal(await session.evaluate('(seekRecording.paused=true,seekMove(24583))'), '24583|play|1')
    await take(100, [])
    assert.equal(await session.evaluate('seekRecording.samplePosition'), '24583')
    await session.evaluate('(seekRecording.paused=false,0)'); await take(20, Array(20).fill(.5))
    await session.evaluate('(seekRecording.stop(),seekRecording.play(),seekMove(16391))')
    await take(20, Array(20).fill(.5))
    assert.equal(await session.evaluate('seekRecording.heard.join(",")'), 'destination,destination')
    await session.evaluate('invalidate seekRecording'); assert.equal(audio.inspect().voices, 0)
  } catch (error) { failures.push(error) }
  release.resolve()
  try { await pending } catch (error) { if (!failures.includes(error)) failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Game recording seek or cleanup failed', { cause: failures[0] })
})
