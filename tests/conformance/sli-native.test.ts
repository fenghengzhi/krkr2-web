import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSli, parseSliBytes, applySliExpression, SliSyntaxError } from '../../src/formats/audio/sli.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { FilteredWaveSource } from '../../src/engine/media/filtered-wave-source.ts'
import { newAudioFilterBudget } from '../../src/engine/media/audio-filter-chain.ts'
import { WaveSegmentQueue } from '../../src/engine/media/audio-segments.ts'
import { wave } from '../helpers/audio.ts'
import { sliNativeFiles, sliNativeLabels, sliNativeFlags, sliInvalidNames } from '../helpers/sli-native-fixtures.ts'

test('SLI original entity delimiters preserve literal double quotes, backslashes, defaults and duplicate fields', () => {
  const parsed = parseSli(String.raw`#2.00
Label {Name="quoted";}
Label {Position=2;Name='path\tone';}
Label {Position=3 Name=bare }
Label {Position=4;}
Link {From=1;From=6samples;To=+2;Smooth=yEs;}
`)
  assert.deepEqual(parsed.labels, [{ position: 0, name: '"quoted"' }, { position: 2, name: 'path\\tone' },
    { position: 3, name: 'bare' }, { position: 4, name: '' }])
  assert.deepEqual(parsed.links, [{ from: 6, to: 0, smooth: true, condition: 'no', reference: 0, variable: 0 }])
  assert.deepEqual(parseSli('#2.00\nLink {Smooth=No;}').links[0],
    { from: 0, to: 0, smooth: false, condition: 'no', reference: 0, variable: 0 })
  for (const text of ["#2.00\nLabel {Name='unfinished;}", '#2.00\nLink {}',
    '#2.00\nLink {From=2;Unknown=0;}', '#2.00\nLink {Smooth=Maybe;Smooth=No;}'])
    assert.throws(() => parseSli(text), SliSyntaxError)
})

test('SLI legacy prefix numbers, version comparison and true line comments follow the native scanner', () => {
  assert.deepEqual(parseSli('prefix LoopLength=0\nLoopStart=3tail').links,
    [{ from: 3, to: 3, smooth: false, condition: 'no', reference: 0, variable: 0 }])
  assert.deepEqual(parseSli('#1.99\n# exact column-zero comment\nLabel {Position=9tail;Name=x;}').labels,
    [{ position: 9, name: 'x' }])
  assert.deepEqual(parseSli('#2.00\nLabel {Position=word;Name=x;}\0trailing-invalid').labels,
    [{ position: 0, name: 'x' }])
  for (const text of ['LoopStart =0\nLoopLength=1', '#2.01\n', '#2.00\n # not a native comment\n',
    "#2.00\nLink {From='-';}"])
    assert.throws(() => parseSli(text), SliSyntaxError)
})

test('SLI same-position comparator prioritizes native condition then flag index and keeps equivalent entries stable', () => {
  const parsed = parseSli('#2.00\n' + ['no', 'eq', 'ne', 'gt', 'ge', 'lt', 'le'].map((condition) =>
    `Link {From=4;To=1;Condition=${condition};CondVar=0;}`).join('\n') +
    '\nLink {From=4;To=2;Condition=le;CondVar=3;}\nLink {From=4;To=3;Condition=le;CondVar=3;}')
  assert.deepEqual(parsed.links.map(({ condition, variable, to }) => [condition, variable, to]),
    [['le', 3, 2], ['le', 3, 3], ['le', 0, 1], ['lt', 0, 1], ['ge', 0, 1], ['gt', 0, 1],
      ['ne', 0, 1], ['eq', 0, 1], ['no', 0, 1]])
})

test('all SLI comparisons and CondVar minus-one produce exact jumped PCM through both waveform source paths', () => {
  const checks = [
    ['eq', 2, true], ['eq', 1, false], ['ne', 1, true], ['ne', 2, false],
    ['gt', 3, true], ['gt', 2, false], ['ge', 2, true], ['ge', 1, false],
    ['lt', 1, true], ['lt', 2, false], ['le', 2, true], ['le', 3, false], ['no', 0, true],
  ] as const
  for (const [condition, value, matches] of checks) for (const variable of [0, -1]) {
    const asset = decodeWav(wave(Array.from({ length: 16 }, (_, i) => i / 32)))!,
      expected = Array.from({ length: 4 }, (_, i) => i / 32).concat(
        Array.from({ length: 4 }, (_, i) => ((matches || variable === -1 ? 8 : 4) + i) / 32))
    asset.loops = parseSli(`#2.00\nLink {From=4;To=8;Condition=${condition};CondVar=${variable};RefValue=2;}`)
    const mixer = new AudioMixer(1000)
    mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
    mixer.command({ op: 'flag', id: 1, index: 0, value })
    mixer.command({ op: 'play', id: 1 })
    const left = new Float32Array(8), right = new Float32Array(8)
    mixer.render(left, right); assert.deepEqual([...left], expected, `${condition}:${value}:${variable}`)
    const flags = Array<number>(16).fill(0); flags[0] = value
    const budget = newAudioFilterBudget(128), source = new FilteredWaveSource(asset, 0, flags, () => false, () => budget),
      output = [new Float32Array(8)], queue = new WaveSegmentQueue()
    assert.equal(source.read(output, 8, queue), 8); assert.deepEqual([...output[0]!], expected)
  }
})

test('native SLI labels execute once with original increment/operand grammar in direct and filtered PCM playback', () => {
  const files = sliNativeFiles(), asset = decodeWav(files['native.wav']!)!
  asset.loops = parseSliBytes(files['native.wav.sli']!)
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
  mixer.command({ op: 'flag', id: 1, index: 1, value: 1 }); mixer.command({ op: 'play', id: 1 })
  const left = new Float32Array(1000), right = new Float32Array(1000), events = mixer.render(left, right)
  assert.deepEqual(events.filter((event) => event.type === 'label').map((event) => event.label), sliNativeLabels)
  assert.deepEqual(mixer.snapshot(1).flags.slice(0, 5), sliNativeFlags)
  assert.deepEqual([...left], [...Array(800).fill(0.25), ...Array(200).fill(0)])
  assert.equal(mixer.snapshot(1).status, 'stop')
  const flags = Array<number>(16).fill(0); flags[1] = 1
  const budget = newAudioFilterBudget(1024), source = new FilteredWaveSource(asset, 0, flags, () => false, () => budget),
    queue = new WaveSegmentQueue(), output = [new Float32Array(1000)], labels: string[] = []
  assert.equal(source.read(output, 1000, queue), 800)
  queue.emitThrough(Infinity, true, (label) => labels.push(label.name))
  assert.deepEqual(labels, sliNativeLabels); assert.deepEqual(flags.slice(0, 5), sliNativeFlags)
  assert.deepEqual(output[0], left)
})

test('invalid label expressions retain flags while valid direct/indirect forms ignore increment operands', () => {
  const flags = Array<number>(16).fill(0); flags[0] = 3; flags[1] = 7
  for (const name of [':[0]=-1', ':[0]+=+2', ':[16]=2', ':[0]=[16]', ':[0]=', ' :[0]++']) {
    assert.equal(applySliExpression(flags, name), false); assert.equal(flags[0], 3)
  }
  for (const [name, expected] of [[':[0]++100', 4], [':[0]--[1]', 3], [':[0]+=[1]', 10],
    [':[0]=[1]', 7], [':[0]-=99', 0], [':[0]+=10000', 9999]] as const) {
    assert.equal(applySliExpression(flags, name), true); assert.equal(flags[0], expected)
  }
})

test('raw SLI bytes decode only label UTF-8 and keep syntax failures separate from safe Web bounds', () => {
  const files = sliNativeFiles()
  for (const name of sliInvalidNames) assert.throws(() => parseSliBytes(files[name + '.sli']!), SliSyntaxError)
  const utf8 = new TextEncoder(), bytes = Uint8Array.from([
    ...utf8.encode('#2.00\n#'), 0xff, ...utf8.encode("\nLabel {Name='日本語';}"),
  ])
  assert.deepEqual(parseSliBytes(bytes).labels, [{ position: 0, name: '日本語' }])
  assert.throws(() => parseSliBytes(Uint8Array.of(0xff, 0xfe, 35, 0, 50, 0)), SliSyntaxError)
  for (const text of ['#2.00\nLink {CondVar=16;}', '#2.00\nLink {From=9007199254740992;}',
    '#2.00\nLink {RefValue=2147483648;}', '#2.00\nLabel {Position=-1;}'])
    assert.throws(() => parseSli(text), (error: unknown) => error instanceof Error && !(error instanceof SliSyntaxError))
})
