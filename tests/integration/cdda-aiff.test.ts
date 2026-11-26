import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { aiffGame, aiffReference } from '../helpers/cdda-aiff.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: actual CDDA player clicks select exact PCM from two independently encoded disc files`, { timeout: 60000 }, async () => {
    const { raw, files } = aiffReference(), clock = new AudioClock(), output: number[][] = [[], []],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left, right) => {
        output[0]!.push(...left); output[1]!.push(...right)
      }, 44100), { session } = await headless(aiffGame(binary, files), {
        audio, now: () => clock.now, schedule: clock.schedule,
      })
    try {
      await session.start()
      const id = Number(await session.evaluate('discWindow.__windowId'))
      for (const track of [2, 1, 4, 3]) {
        const x = (track - 1) * 80 + 38
        await session.input({ type: 'down', windowId: id, x, y: 32, button: 0, shift: 8, clicks: 0 })
        await session.input({ type: 'up', windowId: id, x, y: 32, button: 0, shift: 0, clicks: 1 })
        await session.idle()
        const late = track % 2 === 0
        assert.equal(await session.evaluate('discMusic.status+":"+discMusic.totalTime+":"+discMusic.bits'),
          `play:${late ? 1000 : 2000}:${track < 3 ? 24 : 16}`)
        await settleAudioPages(audio)
        for (const plane of output) plane.length = 0
        clock.advance(20); await session.idle()
        for (const [c, plane] of output.entries()) {
          assert.equal(plane.length, 882)
          const start = late ? 88200 : 0
          for (let i = 0; i < plane.length; i++)
            assert.equal(plane[i], raw.readInt16LE((start + i) * 4 + c * 2) / 32768)
        }
        // Prime the page at the end of this track. Replay the seek and
        // compare both sides of the actual CUE loop against authored samples.
        const length = late ? 44100 : 88200, seek = `discMusic.samplePosition=${length - 441}`
        await session.evaluate(seek); clock.advance(20); await session.idle(); await settleAudioPages(audio)
        await session.evaluate(seek)
        for (const plane of output) plane.length = 0
        clock.advance(20); await session.idle()
        for (const [c, plane] of output.entries()) {
          assert.equal(plane.length, 882)
          for (let i = 0; i < plane.length; i++) {
            const frame = (late ? 88200 : 0) + (length - 441 + i) % length
            assert.equal(plane[i], raw.readInt16LE(frame * 4 + c * 2) / 32768)
          }
        }
      }
      await session.evaluate('discMusic.stop()')
      await session.evaluate('discMusic.open("music/disc-le.aifc")')
      assert.equal(await session.evaluate('discMusic.totalTime+":"+discMusic.bits'), '3000:16')
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((file) => file.path.endsWith('/disc.cjs'))!.bytes)
        .toString('ascii', 0, 4), 'TJS2')
    } finally {
      await session.stop()
      assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    }
  })
