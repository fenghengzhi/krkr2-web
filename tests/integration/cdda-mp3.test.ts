import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { mp3Game, mp3Reference } from '../helpers/cdda-mp3.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: CUE MP3 game buttons select gapless tracks, seek, pause and loop real decoded stereo`, { timeout: 180000 }, async () => {
  const reference = mp3Reference(), clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left, right) => {
      output[0]!.push(...left); output[1]!.push(...right)
    }, 44100), { session } = await headless(mp3Game(binary, reference.files), {
      audio, now: () => clock.now, schedule: clock.schedule,
    })
  try {
    await session.start()
    const windowId = Number(await session.evaluate('mp3Window.__windowId')),
      click = async (x: number) => {
        await session.input({ type: 'down', windowId, x, y: 30, button: 0, shift: 8, clicks: 0 })
        await session.input({ type: 'up', windowId, x, y: 30, button: 0, shift: 0, clicks: 1 })
        await session.idle()
      }
    for (const track of [1, 2, 3, 4]) {
      await click(40)
      const variant = reference.manifest.variants.find((item) => item.name === (track <= 2 ? 'cbr' : 'vbr'))!,
        start = track % 2 ? 0 : 2646000, length = track % 2 ? 2646000 : 2646137,
        take = async (position: number) => {
          await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
          clock.advance(20); await session.idle()
          for (let channel = 0; channel < 2; channel++) {
            assert.equal(output[channel]!.length, 882)
            for (let frame = 0; frame < 882; frame++) {
              const global = start + (position + frame) % length,
                window = variant.windows.find((entry) => global >= entry.start && global < entry.start + entry.frames)
              assert(window, `Reference must cover ${variant.name} PCM frame ${global}`)
              const expected = reference.windows.get(window.file)![channel]![global - window.start]!, actual = output[channel]![frame]!,
                error = Math.abs(actual - expected)
              if (!Number.isFinite(error) || error > .00003)
                throw new Error(`CD track ${track}, frame ${global}, channel ${channel}: ${actual} != ${expected}`)
            }
          }
        }
      assert.equal(await session.evaluate('[mp3Track,mp3Music.status,mp3Music.totalTime,mp3Music.channels,mp3Music.bits].join("|")'),
        `${track}|play|${track % 2 ? 60000 : 60003}|2|32`)
      await take(0)
      await click(120)
      assert.equal(await session.evaluate('mp3Music.samplePosition'), '1764000')
      await take(1764000)
      await click(200)
      const paused = await session.evaluate('mp3Music.samplePosition')
      output.forEach((plane) => { plane.length = 0 }); clock.advance(100); await session.idle()
      assert.deepEqual(output, [[], []]); assert.equal(await session.evaluate('mp3Music.samplePosition'), paused)
      await click(200); await take(1764882)
      // The public sample setter targets the last ten milliseconds exactly;
      // source preparation waits for the real endpoint and loop pages.
      await session.evaluate(`(mp3Music.samplePosition=${length - 441},0)`)
      await take(length - 441)
      assert.equal(await session.evaluate('mp3Music.samplePosition'), '441')
      await click(360)
      assert.equal(await session.evaluate('[mp3Music.status,mp3Music.samplePosition].join("|")'), 'stop|0')
      output.forEach((plane) => { plane.length = 0 }); clock.advance(20); await session.idle()
      assert.deepEqual(output, [[], []])
      await session.evaluate('mp3Music.play()'); await take(0)
      await session.evaluate('mp3Music.stop()')
    }
    if (binary) assert.equal(Buffer.from(session.exportSaves().find((file) => file.path.endsWith('/mp3.cjs'))!.bytes).toString('ascii', 0, 4), 'TJS2')
    await session.evaluate('invalidate mp3Music'); await session.idle()
    assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
  } catch (error) { failures.push(error) }
  try { await session.stop(); assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
  catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'CUE MP3 game playback or cleanup failed', { cause: failures[0] })
})
