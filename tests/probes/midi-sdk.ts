import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { midiOpenCases, midiOpenSource } from '../helpers/midi-contract.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { TjsError } from '../../src/engine/system/tjs-error.ts'
import { midiVolumePublicExpected, midiVolumeSource } from '../helpers/midi-volume.ts'
import { midiReopenExpected, midiReopenFiles, midiReopenSource } from '../helpers/midi-reopen.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const output = resolve('out/verification/native-eri/midi'), game = resolve(output, 'game'), cases = midiOpenCases()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const inputs = cases.map(({ id, bytes, expected }) => ({ id, expected, length: bytes.length, sha256: sha(bytes) }))
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n')
const rawCalls = [
  ['missing', 'MIDISoundBuffer.midiOut()', 'count'],
  ['wrong-type', 'midiMusic.midiOut("not-an-octet")', 'conversion'],
  ['explicit-void', 'MIDISoundBuffer.midiOut(void)', 'void'],
  ['empty-instance', 'midiMusic.midiOut(<% %>)', 'void'],
  ['valid-extra', 'MIDISoundBuffer.midiOut(<% f1 01 f2 01 02 f3 03 f8 %>,123)', 'void'],
] as const

if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  for (const { id, bytes } of cases) writeFileSync(resolve(game, id + '.mid'), bytes)
  for (const [name, bytes] of Object.entries(midiReopenFiles())) writeFileSync(resolve(game, name), bytes)
  const startup = [
    'System.exitOnWindowClose=false; System.exitOnNoWindowStartup=false;',
    'var observations=[]; function record(v){observations.add(v);observations.save("native-events.txt");}',
    'record("start"); System.exceptionHandler=function(e){record("fatal|"+e.message);System.exit();return true;};',
    midiOpenSource,
    ...cases.map(({ id }) => `record("${id}|"+openMidiFile("${id}.mid"));`),
    'var rawRows=[];function logRaw(id,fn){var value;try{value=(fn()===void?"void":"returned");}catch(e){value=e.message;}rawRows.add(id+"|"+value);rawRows.save("native-output.txt");}',
    'System.assignMessage("TJSBadParamCount","count");System.assignMessage("TJSVariantConvertError","conversion");System.assignMessage("TVPMalformedMIDIMessage","malformed");',
    ...rawCalls.map(([id, call]) => `logRaw("${id}",function(){return ${call};});`),
    // The original returns before parsing when MIDI_MAPPER cannot be opened.
    // This bounded truncated F2 distinguishes that path from active output.
    'logRaw("output-path",function(){return MIDISoundBuffer.midiOut(<% f2 01 %>);});',
    midiVolumeSource,
    'var volumeRows=[];try{volumeRows.add(midiVolumePublicControls());}catch(e){volumeRows.add("unexpected-error:"+e.message);}volumeRows.save("native-volume.txt");',
    midiReopenSource,
    'var reopenRows=[];',
    ...Object.keys(midiReopenExpected).map((kind) => `try{reopenRows.add("${kind}|"+midiReopenObserve("${kind}"));}catch(e){reopenRows.add("${kind}|unexpected-error:"+e.message);}reopenRows.save("native-reopen.txt");`),
    'record("done"); System.exit();',
  ].join('\n')
  const script = Buffer.from('\ufeff' + startup, 'utf16le')
  writeFileSync(resolve(game, 'startup.tjs'), script)
  save('inputs.json', { commit: process.env.GITHUB_SHA, startupSha256: sha(script), inputs })
  save('reopen-inputs.json', Object.entries(midiReopenFiles()).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) })))
} else if (process.argv[2] === 'compare') {
  const path = resolve(game, 'native-events.txt')
  const raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const results = inputs.map(({ id, expected, length, sha256 }) => {
    const bytes = readFileSync(resolve(game, id + '.mid'))
    assert.equal(bytes.length, length); assert.equal(sha(bytes), sha256)
    let web = 'opened'
    try { decodeMidi(bytes) } catch (e) {
      if (e instanceof TjsError && e.tjsMessage.id === 'TJSReadError') web = 'read-short'
      else if (e instanceof TvpError && e.tvpMessage.id === 'TVPInvalidSMF' && e.tvpMessage.args.length === 1)
        web = 'smf:<' + e.tvpMessage.args[0] + '>'
      else web = String(e)
    }
    const native = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
    return { id, expected, web, native, matched: native.length === 1 && native[0] === expected && web === expected }
  })
  const sdkPath = resolve(output, 'sdk-process.json')
  const sdk = existsSync(sdkPath) ? JSON.parse(readFileSync(sdkPath, 'utf8').replace(/^\ufeff/, '')) : null
  const complete = sdk?.state === 'observed' && sdk.exitCode === 0 && lines.length === inputs.length + 2 &&
    lines[0] === 'start' && lines.at(-1) === 'done' && results.every((r) => r.matched)
  save('comparison.json', { commit: process.env.GITHUB_SHA, complete, results, observationSha256: raw.length ? sha(raw) : null })
  const rawPath = resolve(game, 'native-output.txt'), outputBytes = existsSync(rawPath) ? readFileSync(rawPath) : Buffer.alloc(0)
  const outputRows = outputBytes.toString(outputBytes[0] === 255 && outputBytes[1] === 254 ? 'utf16le' : 'utf8')
    .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const argumentsMatch = rawCalls.every(([id, , expected], index) => outputRows[index] === id + '|' + expected)
  const device = outputRows.at(-1) === 'output-path|malformed' ? 'active-output' :
    outputRows.at(-1) === 'output-path|void' ? 'original-returned-before-parsing' : 'unreported'
  const rawComplete = sdk?.state === 'observed' && sdk.exitCode === 0 && argumentsMatch &&
    outputRows.length === rawCalls.length + 1 && device !== 'unreported'
  save('raw-output.json', { commit: process.env.GITHUB_SHA, complete: rawComplete, outputRows, device, sha256: sha(outputBytes) })
  const volumePath = resolve(game, 'native-volume.txt'), volumeBytes = existsSync(volumePath) ? readFileSync(volumePath) : Buffer.alloc(0),
    volumeRows = volumeBytes.toString(volumeBytes[0] === 255 && volumeBytes[1] === 254 ? 'utf16le' : 'utf8')
      .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/),
    volumeComplete = sdk?.state === 'observed' && sdk.exitCode === 0 && volumeRows.length === 1 && volumeRows[0] === midiVolumePublicExpected
  save('volume-controls.json', { commit: process.env.GITHUB_SHA, complete: volumeComplete, volumeRows,
    expected: midiVolumePublicExpected, sha256: sha(volumeBytes), device,
    scope: 'Original public volume/volume2 signed-int conversion and clamping only. No MIDI endpoint PCM, timbre or CC7 transport capture is claimed.' })
  for (const [name, expected] of Object.entries(midiReopenFiles())) {
    const input = readFileSync(resolve(game, name)); assert.equal(input.length, expected.length); assert.equal(sha(input), sha(expected))
  }
  const reopenPath = resolve(game, 'native-reopen.txt'), reopenBytes = existsSync(reopenPath) ? readFileSync(reopenPath) : Buffer.alloc(0),
    reopenRows = reopenBytes.toString(reopenBytes[0] === 255 && reopenBytes[1] === 254 ? 'utf16le' : 'utf8')
      .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/),
    expectedReopens = Object.entries(midiReopenExpected).map(([kind, value]) => kind + '|' + value),
    reopenComplete = sdk?.state === 'observed' && sdk.exitCode === 0 && reopenRows.length === expectedReopens.length &&
      reopenRows.every((row, index) => row === expectedReopens[index])
  save('reopen-controls.json', { complete: reopenComplete, reopenRows, expected: expectedReopens, device,
    sha256: sha(reopenBytes), scope: 'Original ordinary stopped/cold MIDI Open, missing storage, malformed SMF and inherited long-fade state. No playback device or native endpoint PCM is claimed.' })
  assert(complete, 'MIDI open observations differ or are incomplete')
  assert(rawComplete, 'Original MIDI signature or output-path observations differ or are incomplete')
  assert(volumeComplete, 'Original MIDI public volume controls differ or are incomplete')
  assert(reopenComplete, 'Original MIDI replacement controls differ or are incomplete')
} else throw new Error('Expected prepare or compare')
