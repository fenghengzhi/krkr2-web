import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { headless } from '../helpers/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { waveTailFiles, waveTailSource } from '../helpers/wave-tail.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: a real WAVE endpoint label starts the next music file before natural stop and survives pause without firing on manual stop`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => { left.push(...l); right.push(...r) }, 1000),
    { session } = await headless({ ...waveTailFiles(), 'tail.tjs': waveTailSource, 'startup.tjs': binary
      ? 'Scripts.compileStorage("tail.tjs","savedata/tail.cjs",false,true,false);Scripts.execStorage("savedata/tail.cjs");'
      : 'Scripts.execStorage("tail.tjs");',
    }, { audio, now: () => clock.now, schedule: clock.schedule })
  const sample = async (l: number[], r: number[]) => {
    await settleAudioPages(audio); clock.advance(20); await session.idle()
    assert.deepEqual(left.splice(0), l); assert.deepEqual(right.splice(0), r)
  }
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves().find((entry) => entry.path === 'savedata/tail.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    for (const name of ['tail-small.wav', 'tail-small-smooth.wav']) {
      assert.equal(await session.evaluate(`waveTailStart("${name}")`), 'play,stop,0')
      await sample(Array(20).fill(0.25), Array(20).fill(-0.5))
      assert.equal(await session.evaluate('waveTailState()'), 'play,stop|head|0')
      await session.evaluate('(tailCurrent.paused=true,0)')
      await sample([], [])
      assert.equal(await session.evaluate('waveTailState()'), 'play,stop|head|0')
      assert.equal(await session.evaluate('tailCurrent.samplePosition'), '20')
      await session.evaluate('(tailCurrent.paused=false,0)')
      await sample([...Array(4).fill(0.25), ...Array(16).fill(0)], [...Array(4).fill(-0.5), ...Array(16).fill(0)])
      assert.equal(await session.evaluate('waveTailState()'), 'stop,play|head,tail,stop|1')
      // The new voice starts from the real TJS onLabel callback after the
      // preceding render block. Its PCM must appear in the next device block.
      await sample(Array(20).fill(0.5), Array(20).fill(0.125))
      assert.equal(await session.evaluate('waveTailState()'), 'stop,play|head,tail,stop|1')
      assert.equal(await session.evaluate('waveTailClose()'), 'closed')
      assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })

      await session.evaluate(`waveTailStart("${name}")`)
      await sample(Array(20).fill(0.25), Array(20).fill(-0.5))
      assert.equal(await session.evaluate('waveTailManualStop()'), 'stop,stop,0')
      await sample([], [])
      assert.equal(await session.evaluate('waveTailState()'), 'stop,stop|head|0')
      // A manual seek changes the actual cursor; it must not flush the tail
      // that was only read ahead by the source-pipeline variant.
      await session.evaluate('(tailCurrent.armed=true,tailCurrent.samplePosition=20,tailCurrent.play(),tailCurrent.samplePosition=0,0)')
      await sample(Array(20).fill(0.25), Array(20).fill(-0.5))
      assert.equal(await session.evaluate('waveTailState()'), 'play,stop|head,head|0')
      await sample([...Array(4).fill(0.25), ...Array(16).fill(0)], [...Array(4).fill(-0.5), ...Array(16).fill(0)])
      assert.equal(await session.evaluate('waveTailState()'), 'stop,play|head,head,tail,stop|1')
      await session.evaluate('waveTailClose()')
    }
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(session.snapshot().handles, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Wave endpoint handoff or cleanup failed', { cause: failures[0] })
})
