import assert from 'node:assert/strict'
import test from 'node:test'
import { VideoPeriod } from '../../src/engine/media/video-period.ts'

test('a past movie cue is rearmed by frame equality and rewind, not by an unrelated clock change', () => {
  const cue = new VideoPeriod()
  cue.set(6, 12)
  assert.equal(cue.take(0), false); assert.equal(cue.take(8), false)
  assert.deepEqual([cue.frame, cue.past], [6, true])
  cue.seekFrame(7)
  assert.equal(cue.take(12), false, 'A frame request after the cue does not rearm it')
  cue.seekFrame(6)
  assert.equal(cue.take(5), false); assert.equal(cue.take(6), true)
  assert.equal(cue.frame, -1); assert.equal(cue.take(12), false)
  cue.set(0, 0); assert.equal(cue.take(0), false)
  cue.rewind(); assert.equal(cue.take(0), true)
})

test('future cues stay armed across forward seeks and every explicit same-value setter recomputes past state', () => {
  const cue = new VideoPeriod()
  cue.set(6, 0)
  cue.seekFrame(12)
  assert.equal(cue.take(12), true, 'SetFrame only clears past; it never marks an armed cue past')
  cue.set(6, 12)
  assert.equal(cue.take(12), false)
  cue.set(6, 0)
  assert.equal(cue.take(6), true, 'Writing the same numeric value is still a real SetPeriodEvent call')
  cue.set(6, 0); cue.set(6, 12)
  assert.equal(cue.take(15), false, 'The inverse same-value assignment disarms a future cue')
})

test('graph reconstruction copies the overlay cue state while consumed and cancelled cues remain disabled', () => {
  const original = new VideoPeriod()
  original.set(6, 12)
  const opened = new VideoPeriod(original.frame, original.past)
  assert.equal(opened.take(12), false)
  opened.rewind(); assert.equal(opened.take(6), true)
  assert.deepEqual([original.frame, original.past], [6, true], 'Candidate changes cannot alter an old graph before commit')
  const consumed = new VideoPeriod(opened.frame, opened.past)
  consumed.rewind(); assert.equal(consumed.take(12), false)
  for (const value of [-1, -2, -2147483648]) {
    consumed.set(value, 0); consumed.rewind(); consumed.seekFrame(0)
    assert.equal(consumed.take(2147483647), false)
  }
})
