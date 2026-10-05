import test from 'node:test'
import assert from 'node:assert/strict'
import { videoClockFrameUpdate } from '../../src/engine/media/video-time.ts'

test('layer frame notifications preserve one-frame differences while mixer notifications use the media clock', () => {
  // Literal EC_UPDATE consumer cases from fixed VideoOvlImpl.cpp:682–689.
  // These are already renderer frame values, not PTS-array indices.
  assert.equal(videoClockFrameUpdate(1, 10, 9), 9)
  assert.equal(videoClockFrameUpdate(1, 10, 10), 10)
  assert.equal(videoClockFrameUpdate(1, 10, 11), 11)
  assert.equal(videoClockFrameUpdate(1, 10, 8), 10)
  assert.equal(videoClockFrameUpdate(1, 10, 12), 10)
  assert.equal(videoClockFrameUpdate(1, 0, -1), -1)
  assert.equal(videoClockFrameUpdate(1, 1, -1), 1)
  assert.equal(videoClockFrameUpdate(1, 10), 10)
  assert.equal(videoClockFrameUpdate(2, 10, 9), 10)
  assert.equal(videoClockFrameUpdate(2, 10, 11), 10)
  assert.equal(videoClockFrameUpdate(2, 10), 10)
})
