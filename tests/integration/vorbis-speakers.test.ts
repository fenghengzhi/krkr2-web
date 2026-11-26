import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { loadVorbisSpeakers, mixVorbisReference, vorbisSpeakerCases, vorbisSpeakerFiles, vorbisSpeakerSource } from '../helpers/vorbis-speakers.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: game Wave playback preserves Vorbis rear/side/center identity through seek, pause, SLI and replay`, { timeout: 120000 }, async () => {
  const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
      (left, right) => { output[0]!.push(...left); output[1]!.push(...right) }, 48000),
    { session } = await headless({ ...vorbisSpeakerFiles(), 'surround.tjs': vorbisSpeakerSource,
      'startup.tjs': binary ? 'Scripts.compileStorage("surround.tjs","savedata/surround.cjs",false,true,false);Scripts.execStorage("savedata/surround.cjs");'
        : 'Scripts.execStorage("surround.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  try {
    await session.start()
    for (const entry of vorbisSpeakerCases) {
      const decoded = await decodePortableAudio(loadVorbisSpeakers(entry).bytes, 'wave')
      assert(decoded?.kind === 'pcm'); assert.equal(decoded.speakerMask, entry.mask)
      const expected = mixVorbisReference(entry, decoded.data), take = async (start: number, blocks: number) => {
        for (let block = 0; block < blocks; block++) {
          await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
          clock.advance(20); await session.idle()
          for (const channel of [0, 1]) assert.deepEqual(output[channel], Array.from({ length: 960 }, (_, at) => {
            const position = start + block * 960 + at, selected = position < 72000 ? position : 24000 + (position - 72000) % 48000
            return 0 + expected[channel]![selected]!
          }), `${entry.name}:channel${channel}:block${block}`)
        }
      }
      assert.equal(await session.evaluate('vorbisNext()'), `${entry.channels}|play`)
      await take(0, 2)
      assert.equal(await session.evaluate('(vorbisMusic.samplePosition=70000,vorbisMusic.samplePosition)'), '70000')
      await take(70000, 4)
      assert.equal(await session.evaluate('[vorbisMusic.samplePosition,vorbisLabels].join("|")'), '25840|1')
      await session.evaluate('(vorbisMusic.paused=true,0)'); output.forEach((plane) => { plane.length = 0 })
      clock.advance(100); await session.idle(); assert.deepEqual(output, [[], []])
      assert.equal(await session.evaluate('vorbisMusic.samplePosition'), '25840')
      await session.evaluate('(vorbisMusic.samplePosition=24000,vorbisMusic.paused=false,0)'); await take(24000, 2)
      assert.equal(await session.evaluate('vorbisLabels'), '2')
      await session.evaluate('(vorbisMusic.stop(),vorbisMusic.play(),0)'); await take(0, 2)
      assert.equal(await session.evaluate('vorbisLabels'), '2')
    }
    await session.evaluate('invalidate vorbisMusic'); assert.equal(audio.inspect().voices, 0)
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Game Vorbis speaker playback or cleanup failed', { cause: failures[0] })
})
