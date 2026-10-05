import test from 'node:test'
import assert from 'node:assert/strict'
import { videoVolumeAttenuation, videoBalanceAttenuation, videoBalanceReadback, videoAudioGains } from '../../src/engine/media/video-audio.ts'

// Independent literal control points from the fixed native formula. The
// expected dB values do not call the production conversion or generate a table.
test('video volume uses integer thousand-step attenuation, including the native one-percent silence boundary', () => {
  for (const [input, attenuation] of [
    [-200000, -10000], [-1, -10000], [0, -10000], [999, -10000], [1000, -10000], [1999, -10000],
    [2000, -8494], [2999, -8494], [10000, -5000], [10999, -5000], [25000, -3010], [25999, -3010],
    [50000, -1505], [50999, -1505], [75000, -624], [99000, -21], [100000, 0], [200000, 0],
  ]) assert.equal(videoVolumeAttenuation(input!), attenuation, String(input))
})

test('video balance keeps the native signed truncation and graph readback instead of echoing the assignment', () => {
  for (const [input, attenuation, readback] of [
    [-200000, -10000, -100000], [-99999, -10000, -100000], [-75999, -3010, -75000],
    [-50999, -1505, -50000], [-25999, -624, -25000], [-999, 0, 0],
    [0, 0, 0], [999, 0, 0], [25999, 624, 25000], [50999, 1505, 50000],
    [75999, 3010, 75000], [99999, 10000, 100000], [200000, 10000, 100000],
  ]) {
    assert.equal(videoBalanceAttenuation(input!), attenuation, String(input))
    assert.equal(videoBalanceReadback(input!), readback, String(input))
  }
})

test('video audio applies hundredth-decibel amplitude per channel without cross-feed', () => {
  const volume = 10 ** (-1505 / 2000), side = 10 ** (-624 / 2000)
  assert.deepEqual(videoAudioGains(50000, 0), { left: volume, right: volume })
  assert.deepEqual(videoAudioGains(50000, 25000), { left: volume * side, right: volume })
  assert.deepEqual(videoAudioGains(50000, -25000), { left: volume, right: volume * side })
  assert.deepEqual(videoAudioGains(50000, 100000), { left: 0, right: volume })
  assert.deepEqual(videoAudioGains(50000, -100000), { left: volume, right: 0 })
  assert.deepEqual(videoAudioGains(1999, 25000), { left: 0, right: 0 })
})

test('video audio changes only on a new native attenuation step and combines both controls', () => {
  assert.deepEqual(videoAudioGains(25999, 75999), videoAudioGains(25000, 75000))
  const quarter = 10 ** (-3010 / 2000)
  assert.deepEqual(videoAudioGains(25000, 75000), { left: quarter * quarter, right: quarter })
  assert.notDeepEqual(videoAudioGains(26000, 75000), videoAudioGains(25000, 75000))
})
