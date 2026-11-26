import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { strictTextDecoder } from '../../src/backends/files/text-decoder.ts'

test('the Windows-949 game decoder matches Python cp949 for every possible lead/trail combination', () => {
  const reference = execFileSync('python3', ['-c', [
    'import sys',
    'out = bytearray()',
    'for lead in range(0x81, 0xff):',
    '    for trail in range(256):',
    '        try: value = ord(bytes([lead, trail]).decode("cp949"))',
    '        except UnicodeDecodeError: value = 0',
    '        out.extend(value.to_bytes(2, "little"))',
    'sys.stdout.buffer.write(out)',
  ].join('\n')])
  const decoder = strictTextDecoder('euc-kr'), pair = new Uint8Array(2)
  assert.equal(reference.length, 126 * 256 * 2)
  for (let lead = 0x81; lead < 0xff; lead++) for (let trail = 0; trail < 256; trail++) {
    pair.set([lead, trail])
    const expected = reference.readUInt16LE(((lead - 0x81) * 256 + trail) * 2)
    if (expected) assert.equal(decoder.decode(pair), String.fromCharCode(expected), pair.toString())
    else assert.throws(() => decoder.decode(pair), TypeError)
  }
  const ascii = Uint8Array.from({ length: 128 }, (_, i) => i)
  assert.equal(decoder.decode(ascii), String.fromCharCode(...ascii))
  assert.throws(() => decoder.decode(Uint8Array.of(0xc7)), TypeError)
  // Cross the internal string chunk boundary with ordinary and extended Hangul.
  assert.equal(decoder.decode(Buffer.from('62c7d181410a'.repeat(2049), 'hex')), 'b한갂\n'.repeat(2049))
})
