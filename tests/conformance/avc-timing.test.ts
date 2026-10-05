import test from 'node:test'
import assert from 'node:assert/strict'
import { readAvcFrameDuration } from '../../src/formats/video/avc-timing.ts'

// Exact avcC SPS bytes from the archived 104 GitHub build. FFprobe independently
// reports 12/1 and 10/1 for these streams in both ordinary and fragmented files.
const twelve = new Uint8Array(Buffer.from('6764000aacb423d80880000003008000000c07891350', 'hex')),
  ten = new Uint8Array(Buffer.from('6764000aacb4293f780880000003008000000a07891350', 'hex')),
  entry = (...sets: Uint8Array[]) => ({ type: 'avc1', avcC: { SPS: sets.map((data) => ({ length: data.length, data })) } })

test('archived progressive AVC SPS retain nominal cadence independently of mux timestamp offsets', () => {
  const before = twelve.slice(), budget = { remaining: twelve.length + ten.length }
  assert.equal(readAvcFrameDuration(entry(twelve), budget), 1000 / 12)
  assert.equal(readAvcFrameDuration(entry(ten), budget), 100)
  assert.equal(budget.remaining, 0)
  assert.deepEqual(twelve, before)
  assert.equal(readAvcFrameDuration(entry(twelve, twelve)), 1000 / 12)
})

test('mixed SPS timing, in-band configurations and unknown profiles never invent one nominal clock', () => {
  assert.equal(readAvcFrameDuration(entry(twelve, ten)), undefined)
  assert.equal(readAvcFrameDuration({ ...entry(twelve), type: 'avc3' }), undefined)
  assert.equal(readAvcFrameDuration({ type: 'hvc1' }), undefined)
  const unsupported = twelve.slice(); unsupported[1] = 99
  assert.equal(readAvcFrameDuration(entry(unsupported)), undefined)
})

test('AVC metadata rejects truncated prefixes, invalid NAL escaping and bounded inventory without changing source bytes', () => {
  assert.throws(() => readAvcFrameDuration(entry(twelve.subarray(0, 10))), /Truncated/)
  const badEscape = Uint8Array.from([...twelve, 0, 0, 3]), forbidden = twelve.slice()
  forbidden[0] = 0xe7
  assert.throws(() => readAvcFrameDuration(entry(badEscape)), /emulation prevention/)
  assert.throws(() => readAvcFrameDuration(entry(Uint8Array.from([...twelve, 0, 0, 1]))), /emulation prevention/)
  assert.throws(() => readAvcFrameDuration(entry(forbidden)), /sequence parameter/)
  forbidden[0] = 7
  assert.throws(() => readAvcFrameDuration(entry(forbidden)), /sequence parameter/)
  assert.throws(() => readAvcFrameDuration(entry()), /inventory/)
  assert.throws(() => readAvcFrameDuration(entry(...Array.from({ length: 32 }, () => twelve))), /inventory/)
  assert.throws(() => readAvcFrameDuration(entry(twelve), { remaining: twelve.length - 1 }), /budget/)
  assert.throws(() => readAvcFrameDuration(entry(twelve), { remaining: NaN }), /budget/)
  assert.throws(() => readAvcFrameDuration({ type: 'avc1', avcC: { SPS: [{ length: 1, data: twelve }] } }), /length/)
})

// Independent minimal baseline SPS syntax: no crops/scaling/POC cycle. Build
// only the declared bits; no implementation parser or timing formula is reused.
function baseline(units: number, scale: number, progressive: boolean, timing = true): Uint8Array {
  const fixed = (value: number, length: number) => value.toString(2).padStart(length, '0'),
    header = fixed(66, 8) + fixed(0, 8) + fixed(30, 8),
    dimensions = '11111' + '0' + '11' + (progressive ? '1' : '00') + '1' + '0',
    vui = '1' + '0000' + (timing ? '1' + fixed(units, 32) + fixed(scale, 32) + '0' : '0'),
    raw = (header + dimensions + vui + '0000' + '1').padEnd(Math.ceil((header + dimensions + vui + '00001').length / 8) * 8, '0'),
    bytes = [0x67]
  let zeros = 0
  for (let at = 0; at < raw.length; at += 8) {
    const byte = Number.parseInt(raw.slice(at, at + 8), 2)
    if (zeros === 2 && byte <= 3) { bytes.push(3); zeros = 0 }
    bytes.push(byte); zeros = byte === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(bytes)
}

test('VUI zero timing fails, absent or field-coded timing is unavailable, and nonfixed progressive nominal timing remains usable', () => {
  assert.equal(readAvcFrameDuration(entry(baseline(1, 50, true))), 40)
  assert.equal(readAvcFrameDuration(entry(baseline(1001, 60000, true))), 1001 / 30)
  assert.equal(readAvcFrameDuration(entry(baseline(1, 50, false))), undefined)
  assert.equal(readAvcFrameDuration(entry(baseline(1, 50, true, false))), undefined)
  assert.throws(() => readAvcFrameDuration(entry(baseline(0, 50, true))), /VUI timing/)
  assert.throws(() => readAvcFrameDuration(entry(baseline(1, 0, true))), /VUI timing/)
})
