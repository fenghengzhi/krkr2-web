import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { sliNativeFiles, sliNativeSource, sliNativeLabels, sliNativeFlags, sliInvalidNames } from '../helpers/sli-native-fixtures.ts'

async function fixture(binary: boolean, run: (value: Awaited<ReturnType<typeof headless>>, audio: HeadlessAudioBackend,
  clock: AudioClock, pcm: number[]) => Promise<void>) {
  const clock = new AudioClock(), pcm: number[] = [], audio = new HeadlessAudioBackend(
    { now: () => clock.now, schedule: clock.schedule }, (left) => pcm.push(...left), 1000), failures: unknown[] = [],
    value = await headless({ ...sliNativeFiles(), 'sli-native.tjs': sliNativeSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("sli-native.tjs","savedata/sli-native.cjs",false,true,false);Scripts.execStorage("savedata/sli-native.cjs");'
        : 'Scripts.execStorage("sli-native.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  try {
    await value.session.start()
    if (binary) assert.equal(new TextDecoder().decode(value.session.exportSaves()
      .find((entry) => entry.path === 'savedata/sli-native.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    await run(value, audio, clock, pcm)
  } catch (error) { failures.push(error) }
  try {
    await value.session.stop()
    assert.equal(clock.tasks.size, 0)
    assert(Object.values(value.session.inspectOwnership()).every((count) => count === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Native SLI consumer or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: SLI raw syntax errors use the current native holder and recover on the same WaveSoundBuffer`, { timeout: 60000 }, async () => {
    await fixture(binary, async ({ session }) => {
      assert.equal(await session.evaluate('sliTryOpen("bad-smooth.wav")'), 'ループ情報 bad-smooth.wav.sli は異常です')
      assert.equal(await session.evaluate('sliSound.status'), 'unload')
      assert.equal(await session.evaluate('System.assignMessage("TVPInvalidLoopInformation","sli-native:<%1>")'), '1')
      for (const name of sliInvalidNames) {
        assert.equal(await session.evaluate(`sliTryOpen("${name}")`), `sli-native:<${name}.sli>`)
        assert.equal(await session.evaluate('sliSound.status'), 'unload')
        assert.equal(await session.evaluate('sliTryOpen("native.wav")'), 'open')
        assert.equal(await session.evaluate('sliSound.status'), 'stop')
      }
      assert.equal(await session.evaluate('sliSound.labels["\\\"quoted\\\""].name'), '"quoted"')
      assert.equal(await session.evaluate('sliSound.labels["path\\\\tone"].samplePosition'), '40')
      assert.equal(await session.evaluate('sliSound.labels["日本語"].samplePosition'), '41')
      await session.evaluate('System.assignMessage("TVPInvalidLoopInformation","reassigned:%1")')
      assert.equal(await session.evaluate('sliTryOpen("bad-field.wav")'), 'reassigned:bad-field.wav.sli')
    })
  })
  test(`${mode}: real waveform SLI conditional jump and labels preserve original flag grammar and exact output samples`, { timeout: 60000 }, async () => {
    await fixture(binary, async ({ session, logs }, audio, clock, pcm) => {
      assert.equal(await session.evaluate('sliBegin()'), '0')
      await settleAudioPages(audio)
      clock.advance(1000); await session.idle()
      assert.equal(await session.evaluate('sliSound.status'), 'stop')
      assert.equal(await session.evaluate('sliLabels.join("|")'), sliNativeLabels.join('|'))
      assert.equal(await session.evaluate('sliFlagText()'), sliNativeFlags.join(','))
      assert(logs.includes('sli-finished:' + sliNativeFlags.join(',')))
      assert.deepEqual(pcm, [...Array(800).fill(0.25), ...Array(200).fill(0)])
      await session.evaluate('(invalidate sliSound,0)')
      await session.idle()
      assert.equal(audio.mixer.inspectStreams().voices, 0)
    })
  })
}
