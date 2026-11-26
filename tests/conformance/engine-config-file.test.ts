import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEngineConfig } from '../../src/engine/system/config-file.ts'

test('engine config keeps original option spelling, spaces, first duplicates and first equals', () => {
  const parsed = parseEngineConfig('jpegdec=low\r\njpegdec=high\rJPEGDEC=normal\n bare \n spaced = value = tail \n-empty=\n=empty-key')
  assert.deepEqual([...parsed], [
    ['-jpegdec', 'low'], ['-JPEGDEC', 'normal'], ['- bare ', 'yes'],
    ['- spaced ', ' value = tail '], ['--empty', ''], ['-', 'empty-key'],
  ])
  assert.equal(parsed.get('-jpegdec'), 'low')
  assert.equal(parsed.has('-spaced'), false)
})

test('engine config skips only semicolons in column zero and does not invent a final blank line', () => {
  assert.deepEqual([...parseEngineConfig('')], [])
  assert.deepEqual([...parseEngineConfig(';one\r\n;two\n')], [])
  assert.deepEqual([...parseEngineConfig('\n;comment\nflag\n\n')], [['-', 'yes'], ['-flag', 'yes']])
  assert.deepEqual([...parseEngineConfig(' ;not-comment\n#not-comment\nx=one;two\n\ufeffname=value')], [
    ['- ;not-comment', 'yes'], ['-#not-comment', 'yes'], ['-x', 'one;two'], ['-\ufeffname', 'value'],
  ])
})

test('quoted engine values use same-quote concatenation and ignore non-string trailing input', () => {
  assert.deepEqual([...parseEngineConfig([
    'double="A"\t "B" suffix', "single='A''B'  'C' ignored",
    'mixed="A"\'B\'', 'comment="A" /*not skipped*/ "B"',
    'leading= "quoted literally"', 'equals="a=b"=ignored', 'empty=""',
    'unicode="日本語 😀"', 'literal="${notExecuted()} &value"',
  ].join('\n'))], [
    ['-double', 'AB'], ['-single', 'ABC'], ['-mixed', 'A'], ['-comment', 'A'],
    ['-leading', ' "quoted literally"'], ['-equals', 'a=b'], ['-empty', ''],
    ['-unicode', '日本語 😀'], ['-literal', '${notExecuted()} &value'],
  ])
  assert.equal(parseEngineConfig('x="A"\v\f"B"').get('-x'), 'AB')
  assert.equal(parseEngineConfig('x="A"\u00a0"B"').get('-x'), 'A')
})

test('TJS escapes distinguish controls, four-digit hex, zero-prefixed octal and ordinary unknown escapes', () => {
  const parsed = parseEngineConfig([
    String.raw`controls="\a\b\f\n\r\t\v"`,
    String.raw`punctuation='quote:\' slash:\\ double:\"'`,
    String.raw`hex="\x41:\X3042:\x12345:\xd83d\xde00"`,
    String.raw`octal="\0101:\0177777:\0200001"`,
    String.raw`unknown="\u0041:\123:\9:\q"`,
    String.raw`zero="A\0B\x0000C\xQ\09D"`,
  ].join('\n'))
  assert.equal(parsed.get('-controls'), '\x07\b\f\n\r\t\v')
  assert.equal(parsed.get('-punctuation'), 'quote:\' slash:\\ double:"')
  assert.equal(parsed.get('-hex'), 'A:あ:\u12345:😀')
  assert.equal(parsed.get('-octal'), 'A:\uffff:\x01')
  assert.equal(parsed.get('-unknown'), 'u0041:123:9:q')
  assert.equal(parsed.get('-zero'), 'ABCQ9D')
})

test('TJS skip-code handling is distinct from an explicitly escaped UTF-16 code unit', () => {
  assert.equal(parseEngineConfig('x="\uffffA\uffffB"\uffff "C"').get('-x'), 'ABC')
  assert.equal(parseEngineConfig(String.raw`x="A\xffffB"`).get('-x'), 'A\uffffB')
  assert.equal(parseEngineConfig('x=raw\ufffftext').get('-x'), 'raw\ufffftext')
  assert.equal(parseEngineConfig('x=before\0after').get('-x'), 'before')
})

test('malformed quoted values fail on their physical line including ignored-priority duplicates', () => {
  for (const text of ['x="', 'x="unterminated', 'x="tail\\', 'x="\\x', 'x="\\012', 'x="a" "unfinished'])
    assert.throws(() => parseEngineConfig(text), { name: 'Error', message: 'Unterminated quoted engine option on line 1' })
  assert.throws(() => parseEngineConfig('x=first\r\n;ignored\r\nx="broken'), {
    name: 'Error', message: 'Unterminated quoted engine option on line 3',
  })
  assert.throws(() => parseEngineConfig('x="line one\nline two"'), {
    name: 'Error', message: 'Unterminated quoted engine option on line 1',
  })
  assert.deepEqual([...parseEngineConfig('ok="safe"')], [['-ok', 'safe']])
})
