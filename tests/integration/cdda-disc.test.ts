import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { cddaGame } from '../helpers/cdda-disc.ts'
import { headless } from '../helpers/headless.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: CDDA selects, seeks and loops within the selected CUE track`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      left.push(...l); right.push(...r)
    }, 1000),
    { session } = await headless(cddaGame(binary), { audio, now: () => clock.now, schedule: clock.schedule })
  const playAt = async (ms: number, loop: boolean) => {
    assert.equal(await session.evaluate(`cdSeek(${ms})`), String(ms * 44100 / 1000))
    assert.equal(await session.evaluate(`cdPlay(${loop})`), 'play')
    // A new playhead outside the primed prefix requests its page on the first
    // render quantum. Wait for the real decoder, then measure from the seek.
    clock.advance(1)
    await session.evaluate('cd.status')
    await settleAudioPages(audio)
    assert.equal(await session.evaluate(`cdSeek(${ms})`), String(ms * 44100 / 1000))
  }
  const render = async (ms: number, expectedLeft: number, expectedRight: number) => {
    left.length = right.length = 0
    for (let i = 0; i < ms; i += 10) {
      await settleAudioPages(audio)
      clock.advance(10)
      await session.idle()
      // Inspect also renders sub-timer intervals against the synthetic clock.
      await session.evaluate('cd.status')
    }
    assert.deepEqual(left, Array(ms).fill(expectedLeft))
    assert.deepEqual(right, Array(ms).fill(expectedRight))
  }
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
      .find((entry) => entry.path === 'savedata/disc-player.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    assert.equal(await session.evaluate('cdOpen("2")'), 'stop,1000,0,2,16')
    await playAt(500, false)
    await render(30, -0.5, 0.375)
    assert.equal(await session.evaluate('cdOpen("D:1")'), 'stop,2000,0,2,16')
    await playAt(1990, true)
    await render(40, 0.25, -0.125)
    assert.equal(await session.evaluate('cd.status'), 'play')
    const position = Number(await session.evaluate('cd.position'))
    assert(position >= 29 && position <= 31, `Expected looped track position near 30ms, got ${position}`)
    assert.equal(await session.evaluate('cdOpen("audio/disc.wav")'), 'stop,3000,0,2,16')
  } finally {
    await session.stop()
    assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
  }
})
